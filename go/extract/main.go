package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
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
	endIndex     = 166
	leftX        = 1860
	rightX       = 1860
	topY         = 1281
	bottomY      = 1282
)

var targets []Target

func init() {
	for x := leftX; x <= rightX; x++ {
		for y := topY; y <= bottomY; y++ {
			targets = append(targets, Target{X: fmt.Sprint(x), Y: fmt.Sprint(y)})
		}
	}
}

func main() {
	numWorkers := 24
	numJobs := endIndex - startIndex + 1

	jobs := make(chan int, numJobs)
	var wg sync.WaitGroup
	wg.Add(numJobs)

	for range numWorkers {
		go func() {
			for i := range jobs {
				worker(i)
				wg.Done()
			}
		}()
	}

	for i := startIndex; i <= endIndex; i++ {
		jobs <- i
	}
	close(jobs)

	wg.Wait()
}

func worker(i int) {
	fmt.Printf("Extracting %d file(s) from tiles-%d.7z in one go...\n", len(targets), i)
	if err := extractMultipleFromArchive(i, targets); err != nil {
		fmt.Printf("Failed for tiles-%d.7z: %v\n", i, err)
		return
	}
	for _, t := range targets {
		fmt.Printf("Wrote %d-X%s-Y%s.png\n", i, t.X, t.Y)
	}
}

func extractMultipleFromArchive(archiveIndex int, targets []Target) error {
	archive := filepath.Join(basePath, fmt.Sprintf("tiles-%d.7z", archiveIndex))

	internal := make([]string, 0, len(targets))
	for _, t := range targets {
		internal = append(internal, fmt.Sprintf("tiles-%d/%s/%s.png", archiveIndex, t.X, t.Y))
	}

	tempOut := filepath.Join(basePath, fmt.Sprintf("__tmp_extract_%d_%d", archiveIndex, time.Now().UnixNano()))
	if err := os.MkdirAll(tempOut, 0o755); err != nil {
		return fmt.Errorf("mkdir temp: %w", err)
	}

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

	for _, t := range targets {
		from := filepath.Join(tempOut, fmt.Sprintf("tiles-%d", archiveIndex), t.X, t.Y+".png")
		to := filepath.Join(basePath, fmt.Sprintf("%d-X%s-Y%s.png", archiveIndex, t.X, t.Y))

		_ = os.Remove(to)

		if err := os.Rename(from, to); err != nil {
			_ = os.RemoveAll(tempOut)
			return fmt.Errorf("rename %s -> %s: %w", from, to, err)
		}
	}

	if err := os.RemoveAll(tempOut); err != nil {
		return fmt.Errorf("cleanup temp: %w", err)
	}
	return nil
}
