package main

import (
	"bytes"
	"flag"
	"fmt"
	"image"
	"image/color"
	imd "image/draw"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ericpauley/go-quantize/quantize"
	"github.com/maruel/natural"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type job struct {
	idx  int
	path string
}
type result struct {
	idx       int
	rgba      *image.RGBA
	err       error
	srcBounds image.Rectangle
}

func isImage(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp":
		return true
	default:
		return false
	}
}

func collectInputs(args []string) ([]string, error) {
	var out []string
	for _, a := range args {
		// glob
		if strings.ContainsAny(a, "*?[]") {
			matches, _ := filepath.Glob(a)
			for _, m := range matches {
				fi, err := os.Stat(m)
				if err != nil {
					continue
				}
				if fi.IsDir() {
					filepath.WalkDir(m, func(p string, d fs.DirEntry, err error) error {
						if err == nil && !d.IsDir() && isImage(p) {
							out = append(out, p)
						}
						return nil
					})
				} else if isImage(m) {
					out = append(out, m)
				}
			}
			continue
		}

		// path (dir or file)
		fi, err := os.Stat(a)
		if err != nil {
			continue
		}
		if fi.IsDir() {
			filepath.WalkDir(a, func(p string, d fs.DirEntry, err error) error {
				if err == nil && !d.IsDir() && isImage(p) {
					out = append(out, p)
				}
				return nil
			})
		} else if isImage(a) {
			out = append(out, a)
		}
	}

	// natural sort
	sort.SliceStable(out, func(i, j int) bool { return natural.Less(out[i], out[j]) })

	// dedupe
	if len(out) == 0 {
		return nil, fmt.Errorf("no input images found")
	}
	dedup := out[:0]
	var last string
	for _, p := range out {
		if p != last {
			dedup = append(dedup, p)
			last = p
		}
	}
	return dedup, nil
}

func decodeRGBA(path string) (*image.RGBA, image.Rectangle, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, image.Rectangle{}, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, image.Rectangle{}, err
	}
	b := img.Bounds()
	rgba := image.NewRGBA(b)
	imd.Draw(rgba, b, img, b.Min, imd.Src)
	return rgba, b, nil
}

func downscaleForSample(src image.Image, maxW int) image.Image {
	b := src.Bounds()
	w := b.Dx()
	h := b.Dy()
	if w <= maxW {
		return src
	}
	newW := maxW
	newH := int(float64(h) * float64(newW) / float64(w))
	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, b, imd.Over, nil)
	return dst
}

func buildGlobalPalette(frames []*image.RGBA, sampleEvery int, colors int, sampleWidth int) color.Palette {
	if sampleEvery < 1 {
		sampleEvery = 1
	}

	// pick one frame to quantize (or blend multiple later if you want)
	// simplest: concatenate all samples into a big composite
	var composite *image.RGBA
	for i := 0; i < len(frames); i += sampleEvery {
		if frames[i] == nil {
			continue
		}
		down := downscaleForSample(frames[i], sampleWidth)
		b := down.Bounds()
		if composite == nil {
			composite = image.NewRGBA(b)
		}
		imd.Draw(composite, b, down, b.Min, imd.Src)
	}

	if composite == nil {
		return color.Palette{color.RGBA{0, 0, 0, 0}}
	}

	q := quantize.MedianCutQuantizer{}
	raw := q.Quantize(make([]color.Color, 0, colors), composite)

	// ensure <= colors and put a transparent entry at index 0
	pal := color.Palette{color.RGBA{0, 0, 0, 0}}
	for _, c := range raw {
		if len(pal) >= colors {
			break
		}
		pal = append(pal, c)
	}
	return pal
}

func toPaletted(src *image.RGBA, pal color.Palette, dither bool) *image.Paletted {
	dst := image.NewPaletted(src.Bounds(), pal)
	if !dither {
		for y := src.Rect.Min.Y; y < src.Rect.Max.Y; y++ {
			sOff := (y - src.Rect.Min.Y) * src.Stride
			dOff := (y - dst.Rect.Min.Y) * dst.Stride
			for x := 0; x < src.Bounds().Dx(); x++ {
				a := src.Pix[sOff+3]
				if a == 0 {
					dst.Pix[dOff+x] = 0
				} else {
					dst.Pix[dOff+x] = uint8(pal.Index(color.RGBA{
						src.Pix[sOff+0], src.Pix[sOff+1], src.Pix[sOff+2], 0xFF,
					}))
				}
				sOff += 4
			}
		}
		return dst
	}
	imd.FloydSteinberg.Draw(dst, src.Bounds(), src, src.Bounds().Min)
	return dst
}

func diffRect(prev, curr *image.Paletted) image.Rectangle {
	if prev == nil {
		return curr.Bounds()
	}
	ub := curr.Bounds().Union(prev.Bounds())
	minx, miny := ub.Max.X, ub.Max.Y
	maxx, maxy := ub.Min.X, ub.Min.Y

	b := curr.Bounds().Intersect(prev.Bounds())
	for y := b.Min.Y; y < b.Max.Y; y++ {
		offCurr := (y-curr.Rect.Min.Y)*curr.Stride + (b.Min.X - curr.Rect.Min.X)
		offPrev := (y-prev.Rect.Min.Y)*prev.Stride + (b.Min.X - prev.Rect.Min.X)
		for x := b.Min.X; x < b.Max.X; x++ {
			if curr.Pix[offCurr] != prev.Pix[offPrev] {
				if x < minx {
					minx = x
				}
				if y < miny {
					miny = y
				}
				if x+1 > maxx {
					maxx = x + 1
				}
				if y+1 > maxy {
					maxy = y + 1
				}
			}
			offCurr++
			offPrev++
		}
	}
	if maxx <= minx || maxy <= miny {
		return image.Rectangle{}
	}
	return image.Rect(minx, miny, maxx, maxy)
}

func cropPaletted(src *image.Paletted, r image.Rectangle) *image.Paletted {
	if r.Empty() {
		p := image.NewPaletted(image.Rect(0, 0, 1, 1), src.Palette)
		p.Pix[0] = 0
		return p
	}
	dst := image.NewPaletted(r, src.Palette)
	for y := r.Min.Y; y < r.Max.Y; y++ {
		sOff := (y-src.Rect.Min.Y)*src.Stride + (r.Min.X - src.Rect.Min.X)
		dOff := (y - r.Min.Y) * dst.Stride
		copy(dst.Pix[dOff:dOff+(r.Dx())], src.Pix[sOff:sOff+(r.Dx())])
	}
	return dst
}

func main() {
	var (
		delayMS     = flag.Int("delay", 200, "frame delay in ms (per frame)")
		colors      = flag.Int("colors", 64, "max palette size (<=256)")
		sampleEvery = flag.Int("sample-every", 3, "use every Nth frame to build global palette")
		sampleWidth = flag.Int("sample-width", 320, "downscale width when sampling for palette")
		concurrency = flag.Int("concurrency", runtime.NumCPU(), "number of decode/convert workers")
		loop        = flag.Int("loop", 0, "loop count: 0 = forever")
		outName     = flag.String("o", "", "output gif filename (optional)")
		noCrop      = flag.Bool("no-crop", false, "disable inter-frame cropping (bigger files)")
		noDither    = flag.Bool("no-dither", false, "disable FS dithering (banding risk, smaller CPU)")
		verbose     = flag.Bool("v", false, "verbose logging")
	)
	flag.Parse()
	if *colors < 2 {
		*colors = 2
	}
	if *colors > 256 {
		*colors = 256
	}
	if flag.NArg() == 0 {
		fmt.Println("usage: gifseq [flags] <files|dirs|globs ...>")
		flag.PrintDefaults()
		os.Exit(2)
	}

	paths, err := collectInputs(flag.Args())
	if err != nil {
		log.Fatal(err)
	}
	if *verbose {
		log.Printf("collected %d frames", len(paths))
	}

	outDir := filepath.Dir(paths[0])
	outFile := *outName
	if outFile == "" {
		base := filepath.Base(paths[0])
		base = strings.TrimSuffix(base, filepath.Ext(base))
		outFile = filepath.Join(outDir, base+"-out.gif")
	} else if !filepath.IsAbs(outFile) {
		outFile = filepath.Join(outDir, outFile)
	}

	start := time.Now()

	jobs := make(chan job, *concurrency*2)
	results := make(chan result, *concurrency*2)

	var wg sync.WaitGroup
	worker := func() {
		defer wg.Done()
		for j := range jobs {
			rgba, b, err := decodeRGBA(j.path)
			results <- result{idx: j.idx, rgba: rgba, err: err, srcBounds: b}
		}
	}
	for i := 0; i < *concurrency; i++ {
		wg.Add(1)
		go worker()
	}
	go func() {
		for i, p := range paths {
			jobs <- job{idx: i, path: p}
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	decoded := make([]*image.RGBA, len(paths))
	var decErr error
	for r := range results {
		if r.err != nil {
			decErr = r.err
			log.Printf("decode failed [%d] %s: %v", r.idx, paths[r.idx], r.err)
			continue
		}
		decoded[r.idx] = r.rgba
	}
	if decErr != nil {
		log.Fatal("one or more decodes failed, aborting")
	}

	pal := buildGlobalPalette(decoded, *sampleEvery, *colors, *sampleWidth)
	if len(pal) < 2 {
		log.Fatal("failed to build a palette")
	}
	if *verbose {
		log.Printf("palette size: %d", len(pal))
	}

	toPal := func(src *image.RGBA) *image.Paletted { return toPaletted(src, pal, !*noDither) }

	g := &gif.GIF{
		Image:     make([]*image.Paletted, 0, len(decoded)),
		Delay:     make([]int, 0, len(decoded)),
		Disposal:  make([]byte, 0, len(decoded)),
		LoopCount: *loop,
	}

	var prevFull *image.Paletted
	for i, fr := range decoded {
		if fr == nil {
			log.Fatalf("missing frame %d", i)
		}
		pframe := toPal(fr)
		if !*noCrop {
			d := diffRect(prevFull, pframe)
			cropped := cropPaletted(pframe, d)
			g.Image = append(g.Image, cropped)
		} else {
			g.Image = append(g.Image, pframe)
		}
		g.Delay = append(g.Delay, int(float64(*delayMS)/10.0))
		g.Disposal = append(g.Disposal, gif.DisposalPrevious)
		prevFull = pframe
	}

	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(outFile, buf.Bytes(), 0644); err != nil {
		log.Fatal(err)
	}

	if *verbose {
		dur := time.Since(start).Round(time.Millisecond)
		info, _ := os.Stat(outFile)
		log.Printf("wrote %s (%d frames, %d bytes) in %s", outFile, len(g.Image), info.Size(), dur)
	} else {
		fmt.Println(outFile)
	}
}
