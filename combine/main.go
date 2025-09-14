package main

import (
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const baseDir = `C:\Users\jazza\Downloads\wplace`
const startN = 1
const endN = 62

// Correct pattern: 5-X1089-Y652.png
var fileRe = regexp.MustCompile(`^(\d+)-X(\d+)-Y(\d+)\.png$`)

func main() {
	for n := startN; n <= endN; n++ {
		if err := processSet(n); err != nil {
			log.Printf("skipping %d: %v", n, err)
		}
	}
}

func processSet(n int) error {
	paths, err := filepath.Glob(filepath.Join(baseDir, fmt.Sprintf("%d-*.png", n)))
	if err != nil {
		return fmt.Errorf("glob error: %w", err)
	}
	if len(paths) == 0 {
		return fmt.Errorf("no files found")
	}

	type key struct{ x, y int }
	tiles := make(map[key]image.Image)
	xSet := map[int]struct{}{}
	ySet := map[int]struct{}{}
	var tileW, tileH int

	for _, p := range paths {
		m := fileRe.FindStringSubmatch(filepath.Base(p))
		if len(m) != 4 {
			continue
		}
		num, _ := strconv.Atoi(m[1])
		if num != n {
			continue
		}
		x, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])

		img, err := readImage(p)
		if err != nil {
			return fmt.Errorf("read %s: %w", p, err)
		}
		tiles[key{x, y}] = img
		xSet[x] = struct{}{}
		ySet[y] = struct{}{}

		b := img.Bounds()
		tileW, tileH = b.Dx(), b.Dy()
	}

	if len(tiles) == 0 {
		return fmt.Errorf("no matching tiles for %d", n)
	}

	xs := sortedKeys(xSet)
	ys := sortedKeys(ySet)
	minX, maxX := xs[0], xs[len(xs)-1]
	minY, maxY := ys[0], ys[len(ys)-1]

	dst := image.NewRGBA(image.Rect(0, 0, tileW*len(xs), tileH*len(ys)))
	for row, y := range ys {
		for col, x := range xs {
			img, ok := tiles[key{x, y}]
			if !ok {
				return fmt.Errorf("missing tile X%d Y%d for %d", x, y, n)
			}
			pt := image.Pt(col*tileW, row*tileH)
			draw.Draw(dst, image.Rect(pt.X, pt.Y, pt.X+tileW, pt.Y+tileH), img, image.Point{}, draw.Src)
		}
	}

	out := filepath.Join(baseDir, fmt.Sprintf("combined-%d-X%dY%d-X%dY%d.png", n, minX, minY, maxX, maxY))
	if err := writePNG(out, dst); err != nil {
		return fmt.Errorf("write output: %w", err)
	}
	log.Printf("wrote %s", out)
	return nil
}

func readImage(p string) (image.Image, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	if strings.EqualFold(filepath.Ext(p), ".png") {
		if img, err := png.Decode(f); err == nil {
			return img, nil
		}
		if _, err := f.Seek(0, 0); err != nil {
			return nil, err
		}
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(f)
	return img, err
}

func writePNG(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	return enc.Encode(f, img)
}

func sortedKeys(m map[int]struct{}) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}
