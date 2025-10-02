package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"sync"

	"github.com/disintegration/imaging"
)

func main() {
	basePath := `C:\Users\jazza\Downloads\wplace`
	x, y := 284, 1310
	// Crop rectangle: (left, top, right, bottom)
	// If using gimp, left and top are inclusive, right and bottom are exclusive
	// So to crop 504,226 to 672,458 you need 504,226,673,459
	cropRect := image.Rect(97, 843, 398, 1148)

	numWorkers := 32
	numJobs := 130

	jobs := make(chan int, numJobs)
	var wg sync.WaitGroup

	for range numWorkers {
		go func() {
			for i := range jobs {
				worker(i, basePath, x, y, cropRect)
				wg.Done()
			}
		}()
	}

	for i := 1; i <= numJobs; i++ {
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
