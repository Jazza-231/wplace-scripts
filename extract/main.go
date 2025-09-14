package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Target struct {
	X string
	Y string
}

const (
	sevenZipPath = `C:\Program Files\7-Zip\7z.exe`
	basePath     = `C:\Users\jazza\Downloads\wplace`
	startIndex   = 1
	endIndex     = 62
)

var targets = []Target{
	{X: "1860", Y: "1282"},
	{X: "1861", Y: "1282"},
	{X: "1862", Y: "1282"},
	{X: "1860", Y: "1283"},
	{X: "1861", Y: "1283"},
	{X: "1862", Y: "1283"},
	{X: "1860", Y: "1284"},
	{X: "1861", Y: "1284"},
	{X: "1862", Y: "1284"},
}

func main() {
	for i := startIndex; i <= endIndex; i++ {
		fmt.Printf("Extracting %d file(s) from tiles-%d.7z in one go...\n", len(targets), i)
		if err := extractMultipleFromArchive(i, targets); err != nil {
			fmt.Printf("❌ Failed for tiles-%d.7z: %v\n", i, err)
			continue
		}
		for _, t := range targets {
			fmt.Printf("✅ Wrote %d-X%s-Y%s.png\n", i, t.X, t.Y)
		}
	}
}

func extractMultipleFromArchive(archiveIndex int, targets []Target) error {
	archive := filepath.Join(basePath, fmt.Sprintf("tiles-%d.7z", archiveIndex))

	// internal paths must use forward slashes (7z paths inside archive)
	internal := make([]string, 0, len(targets))
	for _, t := range targets {
		internal = append(internal, fmt.Sprintf("tiles-%d/%s/%s.png", archiveIndex, t.X, t.Y))
	}

	tempOut := filepath.Join(basePath, fmt.Sprintf("__tmp_extract_%d_%d", archiveIndex, time.Now().UnixNano()))
	if err := os.MkdirAll(tempOut, 0o755); err != nil {
		return fmt.Errorf("mkdir temp: %w", err)
	}

	// 7z x <archive> <paths...> -o<outdir> -y
	args := []string{"x", archive}
	args = append(args, internal...)
	args = append(args, "-o"+tempOut, "-y")

	cmd := exec.Command(sevenZipPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(tempOut)
		return fmt.Errorf("7z run: %w", err)
	}

	// move and rename each file to flat naming
	for _, t := range targets {
		from := filepath.Join(tempOut, fmt.Sprintf("tiles-%d", archiveIndex), t.X, t.Y+".png")
		to := filepath.Join(basePath, fmt.Sprintf("%d-X%s-Y%s.png", archiveIndex, t.X, t.Y))

		// overwrite if present
		_ = os.Remove(to)

		if err := os.Rename(from, to); err != nil {
			_ = os.RemoveAll(tempOut)
			return fmt.Errorf("rename %s -> %s: %w", from, to, err)
		}
	}

	// cleanup temp dir
	if err := os.RemoveAll(tempOut); err != nil {
		return fmt.Errorf("cleanup temp: %w", err)
	}
	return nil
}
