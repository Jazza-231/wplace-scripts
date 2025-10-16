package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

type Target struct {
	X string
	Y string
}

var (
	sevenZipPath string
	basePath     string
	startIndex   int
	endIndex     int
	leftX        int
	rightX       int
	topY         int
	bottomY      int
	workers      int
)

var targets []Target

func init() {
	flag.StringVar(&sevenZipPath, "7zip", "C:\\Program Files\\7-Zip\\7z.exe", "Path to 7zip executable")
	flag.StringVar(&basePath, "base", "C:\\Users\\jazza\\Downloads\\wplace", "Path to folder contain tiles-x.7z files")
	flag.IntVar(&startIndex, "start", 1, "Archive start index")
	flag.IntVar(&endIndex, "end", -1, "Archive end index. If -1, will be set to parse all archives.")
	flag.IntVar(&leftX, "left", 1860, "Left tile X")
	flag.IntVar(&rightX, "right", 1860, "Right tile X")
	flag.IntVar(&topY, "top", 1281, "Top tile Y")
	flag.IntVar(&bottomY, "bottom", 1282, "Bottom tile Y")
	flag.IntVar(&workers, "workers", 24, "Number of instances of 7z to run in parallel")

	flag.Parse()

	if endIndex == -1 {
		endIndex = findEndIndex(basePath)
	}

	for x := leftX; x <= rightX; x++ {
		for y := topY; y <= bottomY; y++ {
			targets = append(targets, Target{X: fmt.Sprint(x), Y: fmt.Sprint(y)})
		}
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
	wg.Add(numJobs)

	for range workers {
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
