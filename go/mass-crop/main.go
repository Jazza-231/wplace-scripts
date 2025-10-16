package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"

	"github.com/disintegration/imaging"
)

type cropJSON struct {
	Left   int `json:"left"`
	Top    int `json:"top"`
	Right  int `json:"right"`
	Bottom int `json:"bottom"`
}

var (
	basePath   string
	startIndex int
	endIndex   int
	x          int
	y          int
	workers    int
	// Crop rectangle: (left, top, right, bottom).
	// If using gimp, left and top are inclusive, right and bottom are exclusive.
	// So to crop 504,226 to 672,458 you need 504,226,673,459
	cropString string
	cropRect   image.Rectangle
)

func init() {
	flag.StringVar(&basePath, "base", "C:\\Users\\jazza\\Downloads\\wplace", "Path to folder contain tiles-x.7z files")
	flag.IntVar(&startIndex, "start", 1, "Archive start index")
	flag.IntVar(&endIndex, "end", -1, "Archive end index. If -1, will be set to parse all archives.")
	flag.IntVar(&x, "x", 1860, "Left tile X")
	flag.IntVar(&y, "y", 1860, "Top tile Y")
	flag.IntVar(&workers, "workers", 24, "Number of images to crop in parallel")
	flag.StringVar(&cropString, "crop", `{"left":0,"top":197,"right":656,"bottom":677}`, "Crop rectangle json")

	flag.Parse()

	var cj cropJSON
	if err := json.Unmarshal([]byte(cropString), &cj); err != nil {
		panic(err)
	}
	cropRect = image.Rect(cj.Left, cj.Top, cj.Right, cj.Bottom)

	if endIndex == -1 {
		endIndex = findEndIndex(basePath)
	}
}

func findEndIndex(basePath string) int {
	files, err := os.ReadDir(basePath)
	if err != nil {
		panic(err)
	}

	biggest := 0

	for _, f := range files {
		reg := regexp.MustCompile(`^tiles-(\d+)\.7z$`)
		matches := reg.FindStringSubmatch(f.Name())

		if len(matches) != 2 {
			continue
		}

		i, err := strconv.Atoi(matches[1])
		if err != nil {
			panic(err)
		}

		if i > biggest {
			biggest = i
		}
	}

	return biggest
}

func main() {
	numJobs := endIndex - startIndex + 1

	jobs := make(chan int, numJobs)
	var wg sync.WaitGroup

	for range workers {
		go func() {
			for i := range jobs {
				worker(i, basePath, x, y, cropRect)
				wg.Done()
			}
		}()
	}

	for i := startIndex; i <= endIndex; i++ {
		wg.Add(1)
		jobs <- i
	}

	close(jobs)
	wg.Wait()
}

func worker(i int, basePath string, x, y int, cropRect image.Rectangle) {
	fileName := fmt.Sprintf("%d-X%d-Y%d.png", i, x, y)
	path := filepath.Join(basePath, fileName)

	img, err := imaging.Open(path)
	if err != nil {
		fmt.Printf("❌ Failed to open %s: %v\n", fileName, err)
		return
	}

	cropped := imaging.Crop(img, cropRect)

	outFile, err := os.Create(path)
	if err != nil {
		fmt.Printf("❌ Failed to create %s: %v\n", fileName, err)
		return
	}
	defer outFile.Close()

	if err := png.Encode(outFile, cropped); err != nil {
		fmt.Printf("❌ Failed to save %s: %v\n", fileName, err)
		return
	}

	fmt.Printf("✅ Cropped %s\n", fileName)
}
