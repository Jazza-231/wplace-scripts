// main.go
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"golang.org/x/image/draw"
)

// ---------------------------------------------------------------------
// Global throttling / HTTP client (OSM rules)
// – ≤ 2 req/s (500 ms tick)
// – polite User‑Agent
// – simple 429‑Retry‑After handling
var (
	rateLimiter = time.NewTicker(500 * time.Millisecond) // 2 req/s
	httpClient  = &http.Client{Timeout: 20 * time.Second}
	userAgent   = "city‑map‑builder/1.0 (+https://example.com; youremail@example.com)"
)

// ---------------------------------------------------------------------
// Data structures -------------------------------------------------------
type Tile struct {
	ID        int    `json:"id"`
	CityID    int    `json:"cityId"`
	Name      string `json:"name"`
	Number    int    `json:"number"`
	CountryID int    `json:"countryId"`
	Coord     struct {
		TileX int `json:"tileX"`
		TileY int `json:"tileY"`
	} `json:"coord"`
}

type CityNumber struct {
	CityID int
	Number int
}

// ---------------------------------------------------------------------
// HSV → RGB conversion -------------------------------------------------
func hsvToRGB(hue, sat, val float64) color.NRGBA {
	h := math.Mod(hue/60.0, 6.0)
	c := val * sat
	x := c * (1 - math.Abs(math.Mod(h, 2)-1))
	m := val - c

	var r, g, b float64
	switch {
	case h < 1:
		r, g, b = c, x, 0
	case h < 2:
		r, g, b = x, c, 0
	case h < 3:
		r, g, b = 0, c, x
	case h < 4:
		r, g, b = 0, x, c
	case h < 5:
		r, g, b = x, 0, c
	default: // h < 6
		r, g, b = c, 0, x
	}
	return color.NRGBA{
		R: uint8((r + m) * 255),
		G: uint8((g + m) * 255),
		B: uint8((b + m) * 255),
		A: 255,
	}
}

// ---------------------------------------------------------------------
// Main ------------------------------------------------------------------
func main() {
	// -------------------- flags --------------------
	dirPtr := flag.String("dir", "regions-uncompressed", "Directory with .jsonl files")
	scalePtr := flag.Int("scale", 4, "Scale factor for final image (1 → 2048, 4 → 8192 …)")
	zoomPtr := flag.Int("zoom", 5, "OSM zoom level (5 → 8192×8192 background)")
	alphaPtr := flag.Float64("alpha", 0.5, "Opacity of the tile layer (0‑1)")
	bgFilePtr := flag.String("bgfile", "", "Path to a local background PNG (overrides OSM tiles)")
	cacheDirPtr := flag.String("cachedir", "", "Directory to cache OSM tiles (default: OS temporary dir)")
	// output file names
	outBgPtr := flag.String("bgout", "raw_background.png", "File for the background map")
	outTilesPtr := flag.String("tilesout", "raw_tiles.png", "File for the raw tile colour map")
	outCombinedPtr := flag.String("combined", "combined.png", "File for the blended output")
	flag.Parse()

	if *scalePtr < 1 {
		log.Fatalf("scale must be >= 1")
	}
	if *alphaPtr < 0 || *alphaPtr > 1 {
		log.Fatalf("alpha must be between 0 and 1")
	}
	if *zoomPtr < 0 || *zoomPtr > 19 {
		log.Fatalf("zoom must be between 0 and 19")
	}

	// -------------------- 1. Load tiles --------------------
	tileMap := make(map[image.Point]CityNumber) // (x,y) → CityNumber
	citySet := make(map[CityNumber]struct{})    // unique CityNumber values

	if err := readAllTiles(*dirPtr, tileMap, citySet); err != nil {
		log.Fatalf("Failed to read tiles: %v", err)
	}

	// -------------------- 2. Colour palette --------------------
	cityColors := assignColors(citySet)

	// -------------------- 3. Background image --------------------
	targetSize := 2048 * (*scalePtr)
	var bgImg *image.NRGBA

	if *bgFilePtr != "" {
		// ---- user supplied PNG ----
		f, err := os.Open(*bgFilePtr)
		if err != nil {
			log.Fatalf("Cannot open background image: %v", err)
		}
		src, _, err := image.Decode(f)
		f.Close()
		if err != nil {
			log.Fatalf("Cannot decode background image: %v", err)
		}
		bgImg = imageToNRGBA(src)

		if bgImg.Bounds().Dx() != targetSize || bgImg.Bounds().Dy() != targetSize {
			res := image.NewNRGBA(image.Rect(0, 0, targetSize, targetSize))
			draw.CatmullRom.Scale(res, res.Bounds(), bgImg, bgImg.Bounds(), draw.Over, nil)
			bgImg = res
		}
	} else {
		// ---- build from OSM tiles (cached) ----
		cacheDir := *cacheDirPtr
		if cacheDir == "" {
			cacheDir = filepath.Join(os.TempDir(), "osm_tile_cache")
		}
		bgImg = buildBackgroundFromOSMTiles(*zoomPtr, cacheDir, targetSize)
	}

	// -------------------- 4. Raw tiles & blended image --------------------
	tileImg := image.NewNRGBA(image.Rect(0, 0, targetSize, targetSize))
	combinedImg := image.NewNRGBA(image.Rect(0, 0, targetSize, targetSize))

	alpha := *alphaPtr

	for pt, cn := range tileMap {
		fg := cityColors[cn]
		startX := pt.X * (*scalePtr)
		startY := pt.Y * (*scalePtr)

		for dy := 0; dy < *scalePtr; dy++ {
			for dx := 0; dx < *scalePtr; dx++ {
				x := startX + dx
				y := startY + dy
				if x >= targetSize || y >= targetSize {
					continue
				}
				// raw tile map (opaque)
				tileImg.SetNRGBA(x, y, fg)

				// blended (source‑over) pixel
				bgC := bgImg.NRGBAAt(x, y)
				r := uint8(float64(fg.R)*alpha + float64(bgC.R)*(1-alpha) + 0.5)
				g := uint8(float64(fg.G)*alpha + float64(bgC.G)*(1-alpha) + 0.5)
				b := uint8(float64(fg.B)*alpha + float64(bgC.B)*(1-alpha) + 0.5)
				combinedImg.SetNRGBA(x, y, color.NRGBA{r, g, b, 255})
			}
		}
	}

	// -------------------- 5. Write PNGs --------------------
	if err := writePNG(*outBgPtr, bgImg); err != nil {
		log.Fatalf("Failed to write background PNG: %v", err)
	}
	if err := writePNG(*outTilesPtr, tileImg); err != nil {
		log.Fatalf("Failed to write tile PNG: %v", err)
	}
	if err := writePNG(*outCombinedPtr, combinedImg); err != nil {
		log.Fatalf("Failed to write combined PNG: %v", err)
	}

	log.Println("All images written successfully.")
}

// ---------------------------------------------------------------------
// 1. Reading the .jsonl files -----------------------------------------
func readAllTiles(dir string,
	tileMap map[image.Point]CityNumber,
	citySet map[CityNumber]struct{}) error {

	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		if err := readSingleFile(filepath.Join(dir, e.Name()), tileMap, citySet); err != nil {
			return err
		}
	}
	return nil
}

func readSingleFile(path string,
	tileMap map[image.Point]CityNumber,
	citySet map[CityNumber]struct{}) error {

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var t Tile
		if err := json.Unmarshal(line, &t); err != nil {
			return err
		}
		// sanity check – the original data set works on a 2048×2048 grid
		if t.Coord.TileX < 0 || t.Coord.TileX >= 2048 ||
			t.Coord.TileY < 0 || t.Coord.TileY >= 2048 {
			continue
		}
		pt := image.Point{X: t.Coord.TileX, Y: t.Coord.TileY}
		cn := CityNumber{CityID: t.CityID, Number: t.Number}
		tileMap[pt] = cn
		citySet[cn] = struct{}{}
	}
	return scanner.Err()
}

// ---------------------------------------------------------------------
// 2. Colour palette ----------------------------------------------------
func assignColors(citySet map[CityNumber]struct{}) map[CityNumber]color.NRGBA {
	colors := make(map[CityNumber]color.NRGBA)
	if len(citySet) == 0 {
		return colors
	}
	// deterministic order → stable palette
	keys := make([]CityNumber, 0, len(citySet))
	for k := range citySet {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].CityID == keys[j].CityID {
			return keys[i].Number < keys[j].Number
		}
		return keys[i].CityID < keys[j].CityID
	})

	const (
		baseSat = 0.65
		val     = 0.7
	)

	step := 360.0 / float64(len(keys))
	hue := 0.0
	for _, k := range keys {
		colors[k] = hsvToRGB(hue, baseSat, val)
		hue = math.Mod(hue+step, 360.0)
	}
	return colors
}

// ---------------------------------------------------------------------
// 3. Build background from OSM tiles (cached) -------------------------
func buildBackgroundFromOSMTiles(zoom int, cacheRoot string, targetSize int) *image.NRGBA {
	const tileSize = 256
	tilesPerSide := 1 << uint(zoom)     // 2^zoom
	fullSize := tileSize * tilesPerSide // size of the assembled OSM image
	full := image.NewNRGBA(image.Rect(0, 0, fullSize, fullSize))

	// concurrency limited to 2 workers (respecting the 2 req/s rule)
	sem := make(chan struct{}, 2)
	var wg sync.WaitGroup

	for ty := 0; ty < tilesPerSide; ty++ {
		for tx := 0; tx < tilesPerSide; tx++ {
			wg.Add(1)
			sem <- struct{}{}
			go func(x, y int) {
				defer wg.Done()
				img, err := getOSMTile(zoom, x, y, cacheRoot)
				if err != nil {
					log.Printf("missing tile %d/%d/%d: %v", zoom, x, y, err)
				} else {
					dest := image.Rect(x*tileSize, y*tileSize, (x+1)*tileSize, (y+1)*tileSize)
					draw.Draw(full, dest, img, image.Point{}, draw.Src)
				}
				<-sem
			}(tx, ty)
		}
	}
	wg.Wait()

	// Resize to the final target size (if the user asked for a different scale)
	if fullSize != targetSize {
		res := image.NewNRGBA(image.Rect(0, 0, targetSize, targetSize))
		draw.CatmullRom.Scale(res, res.Bounds(), full, full.Bounds(), draw.Over, nil)
		return res
	}
	return full
}

// ---------------------------------------------------------------------
// 4. Get a single OSM tile (cache + rate‑limit + 429 handling) -------
func getOSMTile(zoom, x, y int, cacheRoot string) (*image.NRGBA, error) {
	// ----- cache lookup -------------------------------------------------
	tilePath := filepath.Join(cacheRoot,
		strconv.Itoa(zoom),
		strconv.Itoa(x),
		fmt.Sprintf("%d.png", y))

	if data, err := os.ReadFile(tilePath); err == nil {
		img, _, err := image.Decode(bytes.NewReader(data))
		if err == nil {
			return imageToNRGBA(img), nil
		}
		// corrupted cache – fall back to download
	}

	// ----- download (rate‑limited) -------------------------------------
	<-rateLimiter.C // wait for the next 500 ms tick

	url := fmt.Sprintf("https://a.tile.openstreetmap.org/%d/%d/%d.png", zoom, x, y)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// ----- 429 handling -------------------------------------------------
	if resp.StatusCode == http.StatusTooManyRequests {
		// Respect Retry‑After if present, otherwise wait 5 s
		wait := 5 * time.Second
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if secs, e := strconv.Atoi(ra); e == nil {
				wait = time.Duration(secs) * time.Second
			}
		}
		time.Sleep(wait)
		// simple retry (no infinite recursion)
		return getOSMTile(zoom, x, y, cacheRoot)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tile %s returned %s", url, resp.Status)
	}

	// ----- decode + write to cache --------------------------------------
	buf := new(bytes.Buffer)
	tee := io.TeeReader(resp.Body, buf)
	img, _, err := image.Decode(tee)
	if err != nil {
		return nil, err
	}
	// make sure the directory exists
	if err := os.MkdirAll(filepath.Dir(tilePath), 0o755); err != nil {
		return nil, err
	}
	_ = os.WriteFile(tilePath, buf.Bytes(), 0o644)

	return imageToNRGBA(img), nil
}

// ---------------------------------------------------------------------
// 5. Image helpers ------------------------------------------------------
func imageToNRGBA(src image.Image) *image.NRGBA {
	if n, ok := src.(*image.NRGBA); ok {
		return n
	}
	b := src.Bounds()
	nrgba := image.NewNRGBA(b)
	draw.Draw(nrgba, b, src, b.Min, draw.Src)
	return nrgba
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
