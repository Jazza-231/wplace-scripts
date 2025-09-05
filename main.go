// ./image-processor average "C:\Users\jazza\Downloads\wplace\_extract-4_1757064660338\tiles-4\618\719.png" "{}"
package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"runtime"
)

type RGB struct {
	R uint8 `json:"r"`
	G uint8 `json:"g"`
	B uint8 `json:"b"`
}

type HSL struct {
	H float64 `json:"h"`
	S float64 `json:"s"`
	L float64 `json:"l"`
}

type ProcessOpts struct {
	IncludeTransparency bool `json:"includeTransparency"`
	IncludeBoring       bool `json:"includeBoring"`
}

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: %s <function> <filepath> <options>\n", os.Args[0])
	}

	function := os.Args[1]
	filepath := os.Args[2]
	optsJson := os.Args[3]

	var opts ProcessOpts
	if err := json.Unmarshal([]byte(optsJson), &opts); err != nil {
		fmt.Fprintf(os.Stderr, "Invalid options: %v\n", err)
		os.Exit(1)
	}

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

	json.NewEncoder(os.Stdout).Encode(result)

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
		// Convert to RGBA first
		rgba := image.NewRGBA(bounds)
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				rgba.Set(x, y, img.At(x, y))
			}
		}
		return rgba, nil
	}
}

func averageImageFromFile(filepath string, opts ProcessOpts) (RGB, error) {
	img, err := imageFromFile(filepath)
	if err != nil {
		return RGB{}, err
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	return averageRGBA(img.Pix, width, height, opts)
}

func averageRGBA(pixels []uint8, width, height int, opts ProcessOpts) (RGB, error) {
	numWorkers := runtime.NumCPU()
	pixelCount := width * height
	chunkSize := pixelCount / numWorkers

	type result struct{ r, g, b, count float64 }
	results := make(chan result, numWorkers)

	for i := range numWorkers {
		go func(startPixel, endPixel int) {
			var r, g, b, count float64

			for pixel := startPixel; pixel < endPixel; pixel++ {
				idx := pixel * 4
				alpha := float64(pixels[idx+3]) / 255.0

				// Skip fully transparent pixels unless we want to include them
				if alpha <= 0 && !opts.IncludeTransparency {
					continue
				}

				if opts.IncludeTransparency {
					// Include all pixels equally (even transparent ones)
					r += float64(pixels[idx])
					g += float64(pixels[idx+1])
					b += float64(pixels[idx+2])
					count += 1.0
				} else {
					// Weight by alpha (standard alpha blending)
					r += float64(pixels[idx]) * alpha
					g += float64(pixels[idx+1]) * alpha
					b += float64(pixels[idx+2]) * alpha
					count += alpha
				}
			}
			results <- result{r, g, b, count}
		}(i*chunkSize, min((i+1)*chunkSize, pixelCount))
	}

	// Collect results
	var totalR, totalG, totalB, totalCount float64
	for range numWorkers {
		res := <-results
		totalR += res.r
		totalG += res.g
		totalB += res.b
		totalCount += res.count
	}

	if totalCount == 0 {
		return RGB{0, 0, 0}, nil
	}

	return RGB{
		R: uint8(totalR / totalCount),
		G: uint8(totalG / totalCount),
		B: uint8(totalB / totalCount),
	}, nil
}

func countImageFromFile(filepath string) (RGB, error) {

	img, err := imageFromFile(filepath)
	if err != nil {
		return RGB{}, err
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()

	return countRGBA(img.Pix, width, height)
}

func countRGBA(pixels []uint8, width, height int) (RGB, error) {
	numWorkers := runtime.NumCPU()
	pixelCount := width * height
	chunkSize := pixelCount / numWorkers

	type result struct{ count float64 }
	results := make(chan result, numWorkers)

	for i := range numWorkers {
		go func(startPixel, endPixel int) {
			var count float64

			for pixel := startPixel; pixel < endPixel; pixel++ {
				idx := pixel * 4
				alpha := float64(pixels[idx+3]) / 255.0

				// Skip fully transparent pixels unless we want to include them
				if alpha <= 0 {
					continue
				}

				count += 1.0
			}
			results <- result{count}
		}(i*chunkSize, min((i+1)*chunkSize, pixelCount))
	}

	// Collect results
	var totalCount float64
	for range numWorkers {
		res := <-results
		totalCount += res.count
	}

	fmt.Fprintf(os.Stderr, "totalCount: %f\n", totalCount)

	const (
		fracAtHalf = 0.10 // want value=0.5 at this total/pixel fraction
		hueExp     = 1.4  // >1 = linger near red longer
		lightExp   = 2.6  // >1 = darker early
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
		return RGB{}, err
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()

	return modeRGBA(img.Pix, width, height, opts)
}

func modeRGBA(pixels []uint8, width, height int, opts ProcessOpts) (RGB, error) {
	colourCounts := make(map[RGB]int)
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

		colour := RGB{R: r, G: g, B: b}

		if !opts.IncludeBoring {
			if r == 0 && g == 0 && b == 0 {
				continue
			}
			if r == 255 && g == 255 && b == 255 {
				continue
			}
		}

		colourCounts[colour]++
	}

	var maxCount int
	var mostFreqColour RGB

	for colour, count := range colourCounts {
		if count > maxCount {
			maxCount = count
			mostFreqColour = colour
		}
	}

	if maxCount == 0 {
		return RGB{0, 0, 0}, nil
	}

	return mostFreqColour, nil
}
