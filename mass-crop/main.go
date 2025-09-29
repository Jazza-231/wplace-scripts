package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"

	"github.com/disintegration/imaging"
)

func main() {
	basePath := `C:\Users\jazza\Downloads\wplace`
	x, y := 565, 735

	// Crop rectangle: (left, top, right, bottom)
	// If using gimp, left and top are inclusive, right and bottom are exclusive
	// So to crop 504,226 to 672,458 you need 504,226,673,459
	cropRect := image.Rect(780, 140, 2000, 1300)

	for i := 1; i <= 120; i++ {
		fileName := fmt.Sprintf("%d-X%d-Y%d.png", i, x, y)
		path := filepath.Join(basePath, fileName)

		img, err := imaging.Open(path)
		if err != nil {
			fmt.Printf("❌ Failed to open %s: %v\n", fileName, err)
			continue
		}

		cropped := imaging.Crop(img, cropRect)

		outFile, err := os.Create(path)
		if err != nil {
			fmt.Printf("❌ Failed to create %s: %v\n", fileName, err)
			continue
		}
		defer outFile.Close()

		err = png.Encode(outFile, cropped)
		if err != nil {
			fmt.Printf("❌ Failed to save %s: %v\n", fileName, err)
			continue
		}

		// No this isn't AI, I just like emojis
		fmt.Printf("✅ Cropped %s\n", fileName)
	}
}
