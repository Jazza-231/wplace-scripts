// main.go
package main

import (
	"bufio"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	OUTPUT_DIR         = `C:\Users\jazza\Downloads\wplace\cropped`
	ALPHA_THRESHOLD    = 16  // >= alpha counts as solid
	DILATE_RADIUS      = 1   // grow mask before grouping
	MERGE_GAP          = 2   // merge boxes whose grown bounds touch within this gap
	MIN_GROUP_SOLID_PX = 10  // ignore components with fewer solid pixels
	MIN_GROUP_AREA     = 4   // ignore components whose area ≤ this
	PADDING_AT_1X      = 2   // transparent pixels around crop before scaling
	TARGET_WIDTH       = 800 // aim for this width after power-of-two scale
	MAX_POW2_SCALE     = 8   // 1, 2, 4, 8 only
	STRICT_GRID_GUARD  = false

	// min unique colours required to save
	// Set to 0 to disable the check.
	MIN_UNIQUE_COLORS = 3
)

var globalSeq uint64

type component struct {
	minX, minY int
	maxX, maxY int
	count      int
}

var allowedExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true,
}

func isImagePath(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return allowedExt[ext]
}

func basenameNoExt(p string) string {
	base := filepath.Base(p)
	ext := filepath.Ext(base)
	return strings.TrimSuffix(base, ext)
}

func clampInt(x, lo, hi int) int {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

func gcd(a, b int) int {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	for b != 0 {
		a, b = b, a%b
	}
	if a == 0 {
		return 1
	}
	return a
}

// What power is closest to the target
func choosePow2Scale(w int) int {
	width := int(math.Max(1, float64(w)))
	best := 1
	bestDist := math.MaxInt32
	for s := 1; s <= MAX_POW2_SCALE; s <<= 1 {
		dist := intAbs(width*s - TARGET_WIDTH)
		if dist < bestDist {
			bestDist = dist
			best = s
		}
	}
	return best
}

func intAbs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func loadAsNRGBA(path string) (*image.NRGBA, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	img, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}

	if src, ok := img.(*image.NRGBA); ok {
		cp := image.NewNRGBA(src.Bounds())
		draw.Draw(cp, cp.Bounds(), src, src.Bounds().Min, draw.Src)
		return cp, nil
	}

	b := img.Bounds()
	dst := image.NewNRGBA(b)
	draw.Draw(dst, b, img, b.Min, draw.Src)
	return dst, nil
}

func makeMaskNRGBA(img *image.NRGBA) (w, h int, mask []byte, solidCount int) {
	b := img.Bounds()
	w, h = b.Dx(), b.Dy()
	mask = make([]byte, w*h)

	p := 0
	for y := 0; y < h; y++ {
		row := y * img.Stride
		for x := 0; x < w; x++ {
			a := img.Pix[row+4*x+3]
			solid := byte(0)
			if int(a) >= ALPHA_THRESHOLD {
				solid = 1
				solidCount++
			}
			mask[p] = solid
			p++
		}
	}
	return
}

func dilateMask(w, h int, mask []byte, r int) []byte {
	if r <= 0 {
		cp := make([]byte, len(mask))
		copy(cp, mask)
		return cp
	}
	out := make([]byte, len(mask))
	idx := func(x, y int) int { return y*w + x }
	for y := range h {
		for x := range w {
			on := byte(0)
			for dy := -r; dy <= r && on == 0; dy++ {
				yy := y + dy
				if yy < 0 || yy >= h {
					continue
				}
				for dx := -r; dx <= r; dx++ {
					xx := x + dx
					if xx < 0 || xx >= w {
						continue
					}
					if mask[idx(xx, yy)] != 0 {
						on = 1
						break
					}
				}
			}
			out[idx(x, y)] = on
		}
	}
	return out
}

func findComponents8(w, h int, mask []byte) []component {
	visited := make([]byte, len(mask))
	idx := func(x, y int) int { return y*w + x }

	qx := make([]int, w*h)
	qy := make([]int, w*h)

	var comps []component

	for y := range h {
		for x := range w {
			p := idx(x, y)
			if mask[p] == 0 || visited[p] != 0 {
				continue
			}
			head, tail := 0, 0
			qx[tail], qy[tail] = x, y
			tail++
			visited[p] = 1

			minX, maxX := x, x
			minY, maxY := y, y
			count := 0

			for head < tail {
				cx, cy := qx[head], qy[head]
				head++
				count++

				if cx < minX {
					minX = cx
				}
				if cx > maxX {
					maxX = cx
				}
				if cy < minY {
					minY = cy
				}
				if cy > maxY {
					maxY = cy
				}

				for dy := -1; dy <= 1; dy++ {
					for dx := -1; dx <= 1; dx++ {
						if dx == 0 && dy == 0 {
							continue
						}
						nx, ny := cx+dx, cy+dy
						if nx < 0 || ny < 0 || nx >= w || ny >= h {
							continue
						}
						np := idx(nx, ny)
						if mask[np] == 0 || visited[np] != 0 {
							continue
						}
						visited[np] = 1
						qx[tail], qy[tail] = nx, ny
						tail++
					}
				}
			}
			comps = append(comps, component{minX, minY, maxX, maxY, count})
		}
	}
	return comps
}

func mergeTouchingBoxes(boxes []component, gap int) []component {
	if len(boxes) <= 1 {
		cp := make([]component, len(boxes))
		copy(cp, boxes)
		return cp
	}

	expand := func(b component, g int) component {
		return component{b.minX - g, b.minY - g, b.maxX + g, b.maxY + g, b.count}
	}
	intersects := func(a, b component) bool {
		return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY)
	}

	arr := make([]component, len(boxes))
	copy(arr, boxes)

	for {
		changed := false
		used := make([]bool, len(arr))
		next := make([]component, 0, len(arr))

		for i := 0; i < len(arr); i++ {
			if used[i] {
				continue
			}
			cur := arr[i]
			used[i] = true
			exCur := expand(cur, gap)

			for j := i + 1; j < len(arr); j++ {
				if used[j] {
					continue
				}
				exOther := expand(arr[j], gap)
				if intersects(exCur, exOther) {
					if arr[j].minX < cur.minX {
						cur.minX = arr[j].minX
					}
					if arr[j].minY < cur.minY {
						cur.minY = arr[j].minY
					}
					if arr[j].maxX > cur.maxX {
						cur.maxX = arr[j].maxX
					}
					if arr[j].maxY > cur.maxY {
						cur.maxY = arr[j].maxY
					}
					cur.count += arr[j].count
					used[j] = true
					changed = true
					exCur = expand(cur, gap)
				}
			}
			next = append(next, cur)
		}
		arr = next
		if !changed {
			break
		}
	}
	return arr
}

func tightenOnOriginal(mask []byte, w, h int, box component) (component, bool) {
	minX := clampInt(box.minX, 0, w-1)
	minY := clampInt(box.minY, 0, h-1)
	maxX := clampInt(box.maxX, 0, w-1)
	maxY := clampInt(box.maxY, 0, h-1)

	x0, y0 := maxX, maxY
	x1, y1 := minX, minY
	cnt := 0

	for y := minY; y <= maxY; y++ {
		row := y * w
		for x := minX; x <= maxX; x++ {
			if mask[row+x] != 0 {
				if x < x0 {
					x0 = x
				}
				if y < y0 {
					y0 = y
				}
				if x > x1 {
					x1 = x
				}
				if y > y1 {
					y1 = y
				}
				cnt++
			}
		}
	}
	if cnt == 0 {
		return component{}, false
	}
	return component{minX: x0, minY: y0, maxX: x1, maxY: y1, count: cnt}, true
}

func cropAndPad(src *image.NRGBA, r image.Rectangle, pad int) *image.NRGBA {
	b := src.Bounds()
	r = r.Intersect(b)
	w1 := r.Dx() + pad*2
	h1 := r.Dy() + pad*2

	dst := image.NewNRGBA(image.Rect(0, 0, w1, h1))
	pt := image.Pt(r.Min.X, r.Min.Y)
	draw.Draw(dst, image.Rect(pad, pad, pad+r.Dx(), pad+r.Dy()), src, pt, draw.Src)
	return dst
}

func strictGridGuardNRGBA(img *image.NRGBA) bool {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if w <= 1 || h <= 1 {
		return false
	}

	var gH, gV int

	for y := range h {
		row := y * img.Stride
		run := 1
		for x := 1; x < w; x++ {
			i0 := row + 4*(x-1)
			i1 := row + 4*x
			same := img.Pix[i0] == img.Pix[i1] &&
				img.Pix[i0+1] == img.Pix[i1+1] &&
				img.Pix[i0+2] == img.Pix[i1+2] &&
				img.Pix[i0+3] == img.Pix[i1+3]
			if same {
				run++
			} else {
				if gH == 0 {
					gH = run
				} else {
					gH = gcd(gH, run)
				}
				run = 1
			}
		}
		if gH == 0 {
			gH = run
		} else {
			gH = gcd(gH, run)
		}
	}

	for x := range w {
		run := 1
		for y := 1; y < h; y++ {
			i0 := (y-1)*img.Stride + 4*x
			i1 := y*img.Stride + 4*x
			same := img.Pix[i0] == img.Pix[i1] &&
				img.Pix[i0+1] == img.Pix[i1+1] &&
				img.Pix[i0+2] == img.Pix[i1+2] &&
				img.Pix[i0+3] == img.Pix[i1+3]
			if same {
				run++
			} else {
				if gV == 0 {
					gV = run
				} else {
					gV = gcd(gV, run)
				}
				run = 1
			}
		}
		if gV == 0 {
			gV = run
		} else {
			gV = gcd(gV, run)
		}
	}

	return gH > 1 && gV > 1 && gH != gV
}

func nearestResize(src *image.NRGBA, tw, th int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, tw, th))

	sw := src.Bounds().Dx()
	sh := src.Bounds().Dy()
	for y := range th {
		sy := int(float64(y) * float64(sh) / float64(th))
		if sy >= sh {
			sy = sh - 1
		}
		srcRow := sy * src.Stride
		dstRow := y * dst.Stride
		for x := range tw {
			sx := int(float64(x) * float64(sw) / float64(tw))
			if sx >= sw {
				sx = sw - 1
			}
			iSrc := srcRow + 4*sx
			iDst := dstRow + 4*x
			copy(dst.Pix[iDst:iDst+4], src.Pix[iSrc:iSrc+4])
		}
	}
	return dst
}

func savePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	return enc.Encode(f, img)
}

func countUniqueColorsNRGBA(img *image.NRGBA, minNeeded int) (int, bool) {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	seen := make(map[uint32]struct{}, minNeeded)
	for y := range h {
		row := y * img.Stride
		for x := range w {
			i := row + 4*x
			key := uint32(img.Pix[i])<<24 | uint32(img.Pix[i+1])<<16 | uint32(img.Pix[i+2])<<8 | uint32(img.Pix[i+3])
			if _, ok := seen[key]; !ok {
				seen[key] = struct{}{}
				if minNeeded > 0 && len(seen) >= minNeeded {
					return len(seen), true
				}
			}
		}
	}
	if minNeeded > 0 {
		return len(seen), len(seen) >= minNeeded
	}
	return len(seen), true
}

func processImage(path string) error {
	img, err := loadAsNRGBA(path)
	if err != nil {
		return fmt.Errorf("load: %w", err)
	}
	W, H, mask, solidCount := makeMaskNRGBA(img)
	base := basenameNoExt(path)
	parent := filepath.Base(filepath.Dir(path))

	if solidCount <= MIN_GROUP_SOLID_PX {
		fmt.Printf("skip %s: ≤%d solid px\n", base, MIN_GROUP_SOLID_PX)
		return nil
	}

	grown := dilateMask(W, H, mask, DILATE_RADIUS)
	comps := findComponents8(W, H, grown)
	if MERGE_GAP > 0 {
		comps = mergeTouchingBoxes(comps, MERGE_GAP)
	}

	tight := make([]component, 0, len(comps))
	for _, c := range comps {
		t, ok := tightenOnOriginal(mask, W, H, c)
		if !ok {
			continue
		}
		w := t.maxX - t.minX + 1
		h := t.maxY - t.minY + 1
		if t.count < MIN_GROUP_SOLID_PX {
			continue
		}
		if w*h <= MIN_GROUP_AREA {
			continue
		}
		tight = append(tight, t)
	}
	if len(tight) == 0 {
		fmt.Printf("skip %s: no crops\n", base)
		return nil
	}

	for i := 0; i < len(tight)-1; i++ {
		maxIdx := i
		for j := i + 1; j < len(tight); j++ {
			if tight[j].count > tight[maxIdx].count {
				maxIdx = j
			}
		}
		if maxIdx != i {
			tight[i], tight[maxIdx] = tight[maxIdx], tight[i]
		}
	}

	if err := os.MkdirAll(OUTPUT_DIR, 0o755); err != nil {
		return err
	}

	for _, c := range tight {
		x0, y0 := c.minX, c.minY
		cw := c.maxX - c.minX + 1
		ch := c.maxY - c.minY + 1

		cropRect := image.Rect(x0, y0, x0+cw, y0+ch)
		cropped := cropAndPad(img, cropRect, PADDING_AT_1X)
		w1, h1 := cropped.Bounds().Dx(), cropped.Bounds().Dy()

		if STRICT_GRID_GUARD {
			if strictGridGuardNRGBA(cropped) {
				fmt.Printf("warn %s: off-grid upscaled component. Skipping.\n", base)
				continue
			}
		}

		if MIN_UNIQUE_COLORS > 0 {
			uc, ok := countUniqueColorsNRGBA(cropped, MIN_UNIQUE_COLORS)
			if !ok {
				fmt.Printf("skip %s: %d unique colours < %d\n", base, uc, MIN_UNIQUE_COLORS)
				continue
			}
		}

		s := choosePow2Scale(w1)
		TW, TH := w1*s, h1*s

		up := nearestResize(cropped, TW, TH)

		seq := atomic.AddUint64(&globalSeq, 1)
		outName := fmt.Sprintf("%d X%s-%s Y%s-%s.png", seq, parent, parent, base, base)
		outPath := filepath.Join(OUTPUT_DIR, outName)

		if err := savePNG(outPath, up); err != nil {
			return fmt.Errorf("save %s: %w", outName, err)
		}

		fmt.Printf("ok %s %dx%d +pad%d -> %dx%d x%d => %dx%d\n",
			outName, cw, ch, PADDING_AT_1X, w1, h1, s, TW, TH)
	}
	return nil
}

func listImages(targetPath string) ([]string, error) {
	info, err := os.Stat(targetPath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		entries, err := os.ReadDir(targetPath)
		if err != nil {
			return nil, err
		}
		var out []string
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			p := filepath.Join(targetPath, e.Name())
			if isImagePath(p) {
				out = append(out, p)
			}
		}
		return out, nil
	}
	if info.Mode().IsRegular() && isImagePath(targetPath) {
		return []string{targetPath}, nil
	}
	return nil, errors.New("no images found")
}

func runOnceOnPath(p string) {
	imgs, err := listImages(p)
	if err != nil || len(imgs) == 0 {
		fmt.Println("no images found")
		return
	}

	workerCount := min(runtime.NumCPU(), len(imgs))
	wg := sync.WaitGroup{}
	jobs := make(chan string, workerCount*2)

	for range workerCount {
		wg.Go(func() {
			for p := range jobs {
				if err := processImage(p); err != nil {
					fmt.Printf("err %s: %v\n", filepath.Base(p), err)
				}
			}
		})
	}

	for _, p := range imgs {
		jobs <- p
	}
	close(jobs)
	wg.Wait()

	fmt.Printf("done -> %s\n", OUTPUT_DIR)
}

func clearOutputDirImages() int {
	entries, err := os.ReadDir(OUTPUT_DIR)
	if err != nil {
		return 0
	}
	deleted := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		p := filepath.Join(OUTPUT_DIR, e.Name())
		if isImagePath(p) {
			_ = os.Remove(p)
			deleted++
		}
	}
	return deleted
}

func promptLoop() {
	in := bufio.NewReader(os.Stdin)

	for {
		fmt.Print("input file or folder (or STOP to quit): ")
		line, _ := in.ReadString('\n')
		line = strings.TrimSpace(strings.Trim(line, `"'`))
		if line == "" || strings.EqualFold(line, "stop") {
			fmt.Println("stopping")
			return
		}

		if strings.HasPrefix(strings.ToLower(line), "auto ") {
			raw := strings.TrimSpace(line[5:])
			raw = strings.TrimSpace(strings.Trim(raw, `"'`))
			if raw == "" {
				fmt.Println("auto: missing path")
				continue
			}
			clean := filepath.Clean(raw)
			startBase := filepath.Base(clean)
			startIdx, err := strconv.Atoi(startBase)
			if err != nil {
				fmt.Printf("auto: last path segment must be a number, got %q\n", startBase)
				continue
			}
			parentDir := filepath.Dir(clean)
			cur := startIdx

			for {
				curPath := filepath.Join(parentDir, strconv.Itoa(cur))
				fmt.Printf("[auto] processing %s\n", curPath)
				runOnceOnPath(curPath)

				fmt.Printf("[auto] Press Enter for next (%d), type a new path, or STOP: ", cur+1)
				next, _ := in.ReadString('\n')
				next = strings.TrimSpace(strings.Trim(next, `"'`))

				if next == "" {
					n := clearOutputDirImages()
					fmt.Printf("[auto] cleared %d files from %s\n", n, OUTPUT_DIR)
					cur++
					continue
				}
				if strings.EqualFold(next, "stop") {
					fmt.Println("stopping")
					return
				}
				line = next
				break
			}
		}

		if !strings.HasPrefix(strings.ToLower(line), "auto ") {
			runOnceOnPath(line)
		}
	}
}

func main() {

	promptLoop()
}
