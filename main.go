// ./image-processor average "C:\Users\jazza\Downloads\wplace\_extract-4_1757064660338\tiles-4\618\719.png" "{}"
package main

import (
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"os"
	"strings"
	"sync"
	"time"
)

type RGB struct {
	R uint8
	G uint8
	B uint8
}

type HSL struct {
	H float64
	S float64
	L float64
}

type ProcessOpts struct {
	IncludeTransparency bool
	IncludeBoring       bool
}

type Job struct {
	x, y int
}

type Result struct {
	x, y int
	rgb  RGB
}

const wplacePath string = "C:/Users/jazza/Downloads/wplace"

func preCheckExistingFiles(basepath string, width int) map[string]bool {
	existing := make(map[string]bool)

	for x := range width {
		dirPath := fmt.Sprintf("%s/%d", basepath, x)
		if entries, err := os.ReadDir(dirPath); err == nil {
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".png") {
					key := fmt.Sprintf("%s/%s", dirPath, entry.Name())
					existing[key] = true
				}
			}
		}
	}
	return existing
}

func main() {
	folderNumber := 30
	width, height := 2048, 2048
	numWorkers := 32

	runProcess(folderNumber, "count", width, height, numWorkers, ProcessOpts{})

	runProcess(folderNumber, "average", width, height, numWorkers, ProcessOpts{IncludeTransparency: true})
	runProcess(folderNumber, "average", width, height, numWorkers, ProcessOpts{IncludeTransparency: false})

	runProcess(folderNumber, "mode", width, height, numWorkers, ProcessOpts{IncludeBoring: true})
	runProcess(folderNumber, "mode", width, height, numWorkers, ProcessOpts{IncludeBoring: false})
}

func runProcess(folderNumber int, processor string, width, height, numWorkers int, opts ProcessOpts) {
	startTime := time.Now()

	basepath := fmt.Sprintf("%s/tiles-%d/tiles-%d", wplacePath, folderNumber, folderNumber)

	jobs := make(chan Job, 1000)
	results := make(chan Result, 1000)
	existingFiles := preCheckExistingFiles(basepath, width)

	var wg sync.WaitGroup

	for range numWorkers {
		wg.Add(1)
		go worker(jobs, results, &wg, processor, basepath, opts)
	}

	go func() {
		defer close(jobs)
		for x := range width {
			for y := range height {
				filepath := fmt.Sprintf("%s/%d/%d.png", basepath, x, y)
				if existingFiles[filepath] {
					jobs <- Job{x: x, y: y}
				} else {
					results <- Result{x: x, y: y, rgb: RGB{0, 0, 0}}
				}
			}
		}
	}()

	pixelData := make([][]RGB, width)
	allPixels := make([]RGB, width*height)
	for i := range pixelData {
		pixelData[i] = allPixels[i*height : (i+1)*height]
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	processed := 0
	total := width * height

	fmt.Printf("Processing %d pixels with %d workers...\n", total, numWorkers)

	for result := range results {
		pixelData[result.x][result.y] = result.rgb
		processed++

		if processed%5_000 == 0 {
			elapsed := time.Since(startTime)
			progress := float64(processed) / float64(total)

			if progress > 0 {
				totalEstimated := time.Duration(float64(elapsed) / progress)
				remaining := totalEstimated - elapsed

				fmt.Printf("Processed %d/%d pixels (%.1f%%) - Elapsed: %v - ETA: %v\n",
					processed, total, progress*100,
					elapsed.Round(time.Second),
					remaining.Round(time.Second))
			}
		}
	}

	processingTime := time.Since(startTime)
	fmt.Printf("Processing complete! Took: %v\n", processingTime.Round(time.Millisecond))

	fmt.Println("Creating image...")
	imageStartTime := time.Now()

	img := image.NewRGBA(image.Rect(0, 0, width, height))

	// I think doing it without img.Set is faster. Also I fucking love go
	pixels := img.Pix
	stride := img.Stride
	for y := range height {
		off := y * stride
		for x := range width {
			rgb := pixelData[x][y]
			pixels[off+0] = rgb.R
			pixels[off+1] = rgb.G
			pixels[off+2] = rgb.B
			pixels[off+3] = 255
			off += 4
		}
	}

	imageCreationTime := time.Since(imageStartTime)
	fmt.Printf("Image creation took: %v\n", imageCreationTime.Round(time.Millisecond))

	suffix := ""
	if opts.IncludeTransparency {
		suffix += "-t"
	}
	if opts.IncludeBoring {
		suffix += "-b"
	}

	outputPath := fmt.Sprintf("%s/output-%s-%d%s.png", wplacePath, processor, folderNumber, suffix)

	fmt.Fprintf(os.Stderr, "Saving image %s to disk...", outputPath)
	saveStartTime := time.Now()

	file, err := os.Create(outputPath)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	if err := png.Encode(file, img); err != nil {
		panic(err)
	}

	saveTime := time.Since(saveStartTime)
	totalTime := time.Since(startTime)

	fmt.Printf("Image saved successfully!\n")
	fmt.Printf("Save took: %v\n", saveTime.Round(time.Millisecond))
	fmt.Printf("Total time: %v\n", totalTime.Round(time.Millisecond))
	fmt.Printf("Average: %.2f pixels/second\n", float64(total)/totalTime.Seconds())
}

func worker(jobs <-chan Job, results chan<- Result, wg *sync.WaitGroup, processor string, basepath string, opts ProcessOpts) {
	defer wg.Done()
	for job := range jobs {
		filepath := fmt.Sprintf("%s/%d/%d.png", basepath, job.x, job.y)

		rgb, err := processPath(processor, filepath, opts)
		if err != nil {
			rgb = RGB{R: 0, G: 0, B: 0}
		}

		results <- Result{x: job.x, y: job.y, rgb: rgb}
	}
}

func processPath(function string, filepath string, opts ProcessOpts) (RGB, error) {
	var result RGB
	var err error

	switch function {
	case "average":
		result, err = averageImageFromFile(filepath, opts)

	case "count":
		result, err = countImageFromFile(filepath)

	case "mode":
		result, err = modeImageFromFile(filepath, opts)

	default:
		fmt.Fprintf(os.Stderr, "Unknown function: %s\n", function)
		os.Exit(1)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "Processing error: %v\n", err)
		os.Exit(1)
	}

	return result, nil

}

func imageFromFile(filepath string) (*image.RGBA, error) {
	file, err := os.Open(filepath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	img, err := png.Decode(file)
	if err != nil {
		return nil, err
	}

	bounds := img.Bounds()
	switch typedImg := img.(type) {
	case *image.RGBA:
		return typedImg, nil

	default:
		rgba := image.NewRGBA(bounds)
		draw.Draw(rgba, bounds, img, bounds.Min, draw.Src)
		return rgba, nil
	}
}

func averageImageFromFile(filepath string, opts ProcessOpts) (RGB, error) {
	img, err := imageFromFile(filepath)
	if err != nil {
		return RGB{0, 0, 0}, nil
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	return averageRGBA(img.Pix, width, height, opts)
}

func averageRGBA(pixels []uint8, width, height int, opts ProcessOpts) (RGB, error) {
	if width <= 0 || height <= 0 || len(pixels) < width*height*4 {
		return RGB{}, fmt.Errorf("invalid input")
	}

	var r, g, b, count uint64
	for i := 0; i < len(pixels); i += 4 {
		// Since my images never contain semi-transparent pixels (alpha is always 0 or 255)
		// I decided for simplicity and speed (up to 13% from small test?), I can just not handle partial transparency
		// This makes the function less general; images with semi-transparent pixels will not work as expected
		alpha := pixels[i+3]
		if alpha == 0 && !opts.IncludeTransparency {
			continue
		}

		r += uint64(pixels[i])
		g += uint64(pixels[i+1])
		b += uint64(pixels[i+2])
		count++
	}

	if count == 0 {
		return RGB{0, 0, 0}, nil
	}

	return RGB{
		R: uint8(r / count),
		G: uint8(g / count),
		B: uint8(b / count),
	}, nil
}

func countImageFromFile(filepath string) (RGB, error) {

	img, err := imageFromFile(filepath)
	if err != nil {
		return RGB{0, 0, 0}, nil
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()

	return countRGBA(img.Pix, width, height)
}

func countRGBA(pixels []uint8, width, height int) (RGB, error) {
	var totalCount float64
	pixelCount := width * height

	for i := 0; i < len(pixels); i += 4 {
		if pixels[i+3] > 0 {
			totalCount += 1.0
		}
	}

	const (
		fracAtHalf = 0.01 // want value=0.5 at this total/pixel fraction
		hueExp     = 1.1  // >1 = linger near red longer
		lightExp   = 1.6  // >1 = darker early
		lightMax   = 0.9  // brightness ceiling
	)

	var norm float64
	if pixelCount > 0 {
		norm = math.Log1p(totalCount) / math.Log1p(float64(pixelCount))
	}
	if norm < 0 {
		norm = 0
	} else if norm > 1 {
		norm = 1
	}

	f := fracAtHalf
	nf := math.Log1p(f*float64(pixelCount)) / math.Log1p(float64(pixelCount))
	valueExp := math.Log(0.5) / math.Log(nf)

	value := math.Pow(norm, valueExp)
	hue := math.Pow(value, hueExp)
	light := math.Pow(value, lightExp) * lightMax

	return hslToRgb(HSL{H: hue, S: 1, L: light}), nil
}

// Adapted from stackoverflow.com/a/9493060/119527
func hslToRgb(hsl HSL) RGB {
	var r, g, b uint8
	var h, s, l float64 = hsl.H, hsl.S, hsl.L
	var q, p float64

	if s == 0 {
		gray := uint8(math.Round(l * 255))
		r, g, b = gray, gray, gray
	} else {
		if l < 0.5 {
			q = l * (1 + s)
		} else {
			q = l + s - l*s
		}
		p = 2*l - q
		r = uint8(math.Round(float64(hueToRgb(p, q, h+1.0/3)) * 255))
		g = uint8(math.Round(float64(hueToRgb(p, q, h)) * 255))
		b = uint8(math.Round(float64(hueToRgb(p, q, h-1.0/3)) * 255))
	}

	return RGB{R: r, G: g, B: b}
}

func hueToRgb(p, q, t float64) float64 {
	if t < 0 {
		t += 1
	}
	if t > 1 {
		t -= 1
	}
	if t < 1.0/6 {
		return p + (q-p)*6*t
	}
	if t < 1.0/2 {
		return q
	}
	if t < 2.0/3 {
		return p + (q-p)*(2.0/3-t)*6
	}
	return p
}

func modeImageFromFile(filepath string, opts ProcessOpts) (RGB, error) {
	img, err := imageFromFile(filepath)
	if err != nil {
		return RGB{0, 0, 0}, nil
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()

	return modeRGBA(img.Pix, width, height, opts)
}

func modeRGBA(pixels []uint8, width, height int, opts ProcessOpts) (RGB, error) {
	counts := make(map[uint32]int, 64)
	pixelCount := width * height

	for pixel := range pixelCount {
		idx := pixel * 4
		r := pixels[idx]
		g := pixels[idx+1]
		b := pixels[idx+2]
		a := pixels[idx+3]

		if a == 0 {
			continue
		}

		packed := uint32(r)<<16 | uint32(g)<<8 | uint32(b)

		if !opts.IncludeBoring {
			if r == 0 && g == 0 && b == 0 {
				continue
			}
			if r == 255 && g == 255 && b == 255 {
				continue
			}
		}

		counts[packed]++
	}

	var maxCount int
	var mostFreqColour RGB

	for packed, count := range counts {
		if count > maxCount {
			maxCount = count
			colour := RGB{R: byte(packed >> 16), G: byte(packed >> 8), B: byte(packed)}
			mostFreqColour = colour
		}
	}

	if maxCount == 0 {
		return RGB{0, 0, 0}, nil
	}

	return mostFreqColour, nil
}
