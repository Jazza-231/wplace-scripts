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
	x, y := 1083, 695

	// Crop rectangle: (left, top, right, bottom)
	cropRect := image.Rect(162, 564, 637, 831)

	for i := 1; i <= 72; i++ {
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
