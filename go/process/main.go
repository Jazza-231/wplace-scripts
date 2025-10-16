package main

import (
	"errors"
	"flag"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"os"
	"os/exec"
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

var wplacePath string = "C:/Users/jazza/Downloads/wplace"

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
	folderStart := 1
	folderEnd := -1
	width, height := 2048, 2048
	numWorkers := 16
	singleFolder := false
	extract := false
	tempPath := os.TempDir()
	operations := "c m"

	flag.IntVar(&folderStart, "f", folderStart, "The folder number to start processing at")
	flag.IntVar(&folderEnd, "l", folderEnd, "The folder number to end processing at. Omit or set to -1 to process only 1 folder")
	flag.IntVar(&numWorkers, "w", numWorkers, "The number of workers to use")
	flag.StringVar(&wplacePath, "p", wplacePath, "The path to the wplace folder, namely the folder containing the tiles-x folder")
	flag.BoolVar(&singleFolder, "s", singleFolder, "Whether the archive is tiles-x.7z/tiles-x or just tiles-x.7z")
	flag.BoolVar(&extract, "e", extract, "Whether to extract the archive automatically or not")
	flag.StringVar(&tempPath, "t", tempPath, "The path to the temporary folder to extract the archive to")
	flag.StringVar(&operations, "o", operations, "The operations: c=count, m=mode, a=average, modifiers: t=transparent, b=boring")
	flag.Parse()

	tilesByFolder := make(map[int]string)
	extractWorkers := 8

	if folderEnd == -1 {
		folderEnd = folderStart
	}

	{
		var mutex sync.Mutex
		var folders []int
		for folderNum := folderStart; folderNum <= folderEnd; folderNum++ {
			folders = append(folders, folderNum)
		}

		runWorkers(folders, extractWorkers, func(folderNum int) {
			var p string
			if extract {
				p = extractTiles(tempPath, folderNum)
			} else {
				p = getTilesFolderPath(wplacePath, folderNum, singleFolder)
			}
			mutex.Lock()
			tilesByFolder[folderNum] = p
			mutex.Unlock()
		})
	}

	for folderNum := folderStart; folderNum <= folderEnd; folderNum++ {
		p := tilesByFolder[folderNum]
		operationFuncs, err := chooseOperations(operations)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		for _, fn := range operationFuncs {
			fn(folderNum, width, height, numWorkers, p)
		}
	}

	{
		var paths []string
		for _, p := range tilesByFolder {
			paths = append(paths, p)
		}

		if extract {
			runWorkers(paths, extractWorkers, func(p string) {
				deleteTilesFolder(p)
			})
		}
	}
}

// This was actually so fun to figure out, idk if I have ever returned functions in code before
func chooseOperations(operationsString string) ([]func(folderNum, width, height, numWorkers int, p string), error) {
	specs := map[string]struct {
		name string
		opts ProcessOpts
	}{
		"c":  {"count", ProcessOpts{IncludeBoring: false, IncludeTransparency: false}},
		"m":  {"mode", ProcessOpts{IncludeBoring: false, IncludeTransparency: false}},
		"a":  {"average", ProcessOpts{IncludeBoring: false, IncludeTransparency: false}},
		"mb": {"mode", ProcessOpts{IncludeBoring: true, IncludeTransparency: false}},
		"at": {"average", ProcessOpts{IncludeBoring: false, IncludeTransparency: true}},
	}

	tokens := strings.FieldsFunc(operationsString, func(r rune) bool { return r == ',' || r == ' ' })

	functions := make([]func(folderNum, width, height, numWorkers int, p string), 0, len(tokens))
	for _, t := range tokens {
		spec, ok := specs[t]
		if !ok {
			return nil, fmt.Errorf("unknown operation %q", t)
		}
		name := spec.name
		opts := spec.opts
		functions = append(functions, func(folderNum, width, height, numWorkers int, p string) {
			runProcess(folderNum, name, width, height, numWorkers, p, opts)
		})
	}

	if len(functions) == 0 {
		return nil, errors.New("no operations specified")
	}
	return functions, nil
}

func runWorkers[T any](items []T, numWorkers int, fn func(T)) {
	if numWorkers < 1 {
		numWorkers = 1
	}

	var wg sync.WaitGroup
	jobs := make(chan T)

	for i := 0; i < numWorkers; i++ {
		wg.Go(func() {
			for it := range jobs {
				fn(it)
			}
		})
	}

	for _, it := range items {
		jobs <- it
	}
	close(jobs)
	wg.Wait()
}

func getTilesFolderPath(wplaceOrTemp string, folderNumber int, singleFolder bool) (tilesFolderPath string) {
	if singleFolder {
		tilesFolderPath = fmt.Sprintf("%s/tiles-%d", wplaceOrTemp, folderNumber)
	} else {
		tilesFolderPath = fmt.Sprintf("%s/tiles-%d/tiles-%d", wplaceOrTemp, folderNumber, folderNumber)
	}

	return tilesFolderPath
}

func extractTiles(tempPath string, folderNumber int) (tilesFolderPath string) {
	if !exists(tempPath) {
		fmt.Printf("Creating temp path %s...\n", tempPath)
		os.Mkdir(tempPath, os.ModePerm)
	}

	extractFrom := fmt.Sprintf("%s/tiles-%d.7z", wplacePath, folderNumber)

	fmt.Printf("Extracting %s to %s\n", extractFrom, tempPath)
	sevenZArgs := []string{"x", "-o" + tempPath, extractFrom}

	err := exec.Command("7z", sevenZArgs...).Run()

	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Done!")

	return fmt.Sprintf("%s/tiles-%d", tempPath, folderNumber)
}

func deleteTilesFolder(tilesFolderPath string) {
	fmt.Fprintf(os.Stderr, "Deleting %s...\n", tilesFolderPath)
	err := os.RemoveAll(tilesFolderPath)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Done!")
}

func runProcess(folderNumber int, processor string, width, height, numWorkers int, tilesFolderPath string, opts ProcessOpts) {
	startTime := time.Now()

	if !exists(tilesFolderPath) {
		fmt.Printf("Folder \"%s\" does not exist!\n", tilesFolderPath)
		os.Exit(1)
	}

	jobs := make(chan Job, 1000)
	results := make(chan Result, 1000)
	existingFiles := preCheckExistingFiles(tilesFolderPath, width)

	var wg sync.WaitGroup

	for range numWorkers {
		wg.Add(1)
		go worker(jobs, results, &wg, processor, tilesFolderPath, opts)
	}

	go func() {
		defer close(jobs)
		for x := range width {
			for y := range height {
				filepath := fmt.Sprintf("%s/%d/%d.png", tilesFolderPath, x, y)
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

	suffix := ""
	if opts.IncludeTransparency {
		suffix += "-t"
	}
	if opts.IncludeBoring {
		suffix += "-b"
	}

	fmt.Printf("Processing %d pixels in %s with %d workers doing %s%s...\n", total, tilesFolderPath, numWorkers, processor, suffix)

	for result := range results {
		pixelData[result.x][result.y] = result.rgb
		processed++

		if processed%20_000 == 0 {
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

	outputFolder := fmt.Sprintf("%s/data", wplacePath)
	if !exists(outputFolder) {
		fmt.Printf("Creating output folder %s...\n", outputFolder)
		os.Mkdir(outputFolder, os.ModePerm)
	}
	outputPath := fmt.Sprintf("%s/%d-%s%s.png", outputFolder, folderNumber, processor, suffix)

	fmt.Fprintf(os.Stderr, "Saving image %s to disk...", outputPath)
	saveStartTime := time.Now()

	file, err := os.Create(outputPath)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	encoder := png.Encoder{CompressionLevel: png.BestCompression}

	if err := encoder.Encode(file, img); err != nil {
		panic(err)
	}

	saveTime := time.Since(saveStartTime)
	totalTime := time.Since(startTime)

	fmt.Printf("Image saved successfully!\n")
	fmt.Printf("Save took: %v\n", saveTime.Round(time.Millisecond))
	fmt.Printf("Total time: %v\n", totalTime.Round(time.Millisecond))
	fmt.Printf("Average: %.2f pixels/second\n", float64(total)/totalTime.Seconds())

}

func exists(basepath string) bool {
	_, err := os.Stat(basepath)
	return !errors.Is(err, os.ErrNotExist)
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
		hueExp     = 0.8  // >1 = linger near red longer
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
