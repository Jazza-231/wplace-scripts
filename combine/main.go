package main

import (
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
)

type Target struct {
	X string
	Y string
}

const (
	basePath        = `C:\Users\jazza\Downloads\wplace`
	startIndex      = 1
	endIndex        = 150
	leftX           = 1331
	rightX          = 1332
	topY            = 763
	bottomY         = 763
	deleteOriginals = true
)

var targets []Target

func init() {
	for x := leftX; x <= rightX; x++ {
		for y := topY; y <= bottomY; y++ {
			targets = append(targets, Target{X: fmt.Sprint(x), Y: fmt.Sprint(y)})
		}
	}
}

func main() {
	if len(targets) == 0 {
		fmt.Println("no targets defined")
		return
	}

	xVals, yVals := uniqSortedXY(targets)

	workers := 24
	idxCh := make(chan int)
	var wg sync.WaitGroup
	wg.Add(workers)

	for range workers {
		go func() {
			defer wg.Done()
			for n := range idxCh {
				if err := combineIndex(n, xVals, yVals); err != nil {
					fmt.Printf("index %d: %v\n", n, err)
				} else {
					fmt.Printf("OK %d\n", n)
				}
			}
		}()
	}

	for n := startIndex; n <= endIndex; n++ {
		idxCh <- n
	}
	close(idxCh)
	wg.Wait()
}

func combineIndex(n int, xVals, yVals []int) error {
	type tile struct {
		img  image.Image
		w    int
		h    int
		x    int
		y    int
		path string
	}

	tiles := make([]tile, 0, len(xVals)*len(yVals))

	for _, y := range yVals {
		for _, x := range xVals {
			inPath := filepath.Join(basePath, fmt.Sprintf(`%d-X%d-Y%d.png`, n, x, y))
			f, err := os.Open(inPath)
			if err != nil {
				return fmt.Errorf("open %s: %w", inPath, err)
			}
			img, err := png.Decode(f)
			f.Close()
			if err != nil {
				return fmt.Errorf("decode %s: %w", inPath, err)
			}
			b := img.Bounds()
			tiles = append(tiles, tile{img: img, w: b.Dx(), h: b.Dy(), x: x, y: y, path: inPath})
		}
	}

	if len(tiles) == 0 {
		return fmt.Errorf("no tiles found for %d", n)
	}

	tw, th := tiles[0].w, tiles[0].h
	for _, t := range tiles[1:] {
		if t.w != tw || t.h != th {
			return fmt.Errorf("mismatched tile sizes: expected %dx%d, got %dx%d at X%d Y%d",
				tw, th, t.w, t.h, t.x, t.y)
		}
	}

	gridW := len(xVals)
	gridH := len(yVals)
	outW := gridW * tw
	outH := gridH * th

	out := image.NewRGBA(image.Rect(0, 0, outW, outH))

	for _, t := range tiles {
		xIdx := idxOf(xVals, t.x)
		yIdx := idxOf(yVals, t.y)
		if xIdx < 0 || yIdx < 0 {
			return fmt.Errorf("unexpected coord not in grid: X%d Y%d", t.x, t.y)
		}
		dst := image.Rect(xIdx*tw, yIdx*th, (xIdx+1)*tw, (yIdx+1)*th)
		draw.Draw(out, dst, t.img, t.img.Bounds().Min, draw.Src)
	}

	outPath := filepath.Join(basePath, fmt.Sprintf(`%d-X%d-Y%d.png`, n, xVals[0], yVals[len(yVals)-1]))

	if err := writePNGAtomic(outPath+".tmpwrite", outPath, out); err != nil {
		return err
	}

	if deleteOriginals {
		for _, t := range tiles {
			if t.path == outPath {
				continue
			}
			if err := os.Remove(t.path); err != nil && !os.IsNotExist(err) {
				fmt.Printf("delete %s: %v\n", t.path, err)
			}
		}
	}

	return nil
}

func uniqSortedXY(ts []Target) ([]int, []int) {
	xm := map[int]struct{}{}
	ym := map[int]struct{}{}
	for _, t := range ts {
		xi, _ := strconv.Atoi(t.X)
		yi, _ := strconv.Atoi(t.Y)
		xm[xi] = struct{}{}
		ym[yi] = struct{}{}
	}
	xs := make([]int, 0, len(xm))
	ys := make([]int, 0, len(ym))
	for k := range xm {
		xs = append(xs, k)
	}
	for k := range ym {
		ys = append(ys, k)
	}
	sort.Ints(xs)
	sort.Ints(ys)
	return xs, ys
}

func idxOf(arr []int, v int) int {
	i := sort.SearchInts(arr, v)
	if i < len(arr) && arr[i] == v {
		return i
	}
	return -1
}

func writePNGAtomic(tmpPath, finalPath string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(finalPath), err)
	}
	out, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmpPath, err)
	}
	if err := png.Encode(out, img); err != nil {
		out.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("encode %s: %w", tmpPath, err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close %s: %w", tmpPath, err)
	}
	_ = os.Remove(finalPath)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, finalPath, err)
	}
	return nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
