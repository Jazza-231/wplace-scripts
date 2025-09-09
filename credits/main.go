package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

type PaintedBy struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	AllianceID   int    `json:"allianceId"`
	AllianceName string `json:"allianceName"`
	EquippedFlag int    `json:"equippedFlag"`
}
type PixelResponse struct {
	PaintedBy PaintedBy `json:"paintedBy"`
}

type Coord struct {
	TileX int `json:"tileX"`
	TileY int `json:"tileY"`
	X     int `json:"x"`
	Y     int `json:"y"`
}

type UserCredits struct {
	ID     int     `json:"id"`
	Name   string  `json:"name"`
	Count  int     `json:"count"`
	Coords []Coord `json:"coords"`
}

type task struct {
	tileX int
	tileY int
	x     int
	y     int
}

type paintedByResult struct {
	user PaintedBy
	at   Coord
}

type failEvent struct {
	url     string
	reason  string
	attempt int  // 0-based attempt index
	final   bool // true if this is the last attempt (data lost)
}

type failRing struct {
	mu     sync.Mutex
	buf    []failEvent
	cursor int
	full   bool
}

func newFailRing(n int) *failRing {
	return &failRing{buf: make([]failEvent, n)}
}

func (r *failRing) add(v failEvent) {
	r.mu.Lock()
	r.buf[r.cursor] = v
	r.cursor = (r.cursor + 1) % len(r.buf)
	if r.cursor == 0 {
		r.full = true
	}
	r.mu.Unlock()
}

func (r *failRing) snapshot(max int) []failEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.buf)
	if !r.full {
		n = r.cursor
	}
	if n == 0 {
		return nil
	}
	if max > n {
		max = n
	}
	out := make([]failEvent, 0, max)
	idx := (r.cursor - 1 + len(r.buf)) % len(r.buf)
	for i := 0; i < max; i++ {
		out = append(out, r.buf[idx])
		if idx == 0 {
			idx = len(r.buf) - 1
			if !r.full {
				break
			}
		} else {
			idx--
		}
	}
	return out
}

func main() {
	const (
		baseURL     = "https://backend.wplace.live/s0/pixel"
		outPath     = `C:\Users\jazza\Downloads\wplace\credits.json`
		maxRetries  = 10 // total attempts = maxRetries+1
		logEvery    = 5 * time.Second
		userAgent   = "Mozilla/5.0 (compatible; wplace-prober/1.1)"
		cfClearance = ""
		jCookie     = ""

		tileX      = 1069
		xMin, xMax = 184, 912

		startTileY = 670
		startY     = 606
		endTileY   = 671
		endY       = 334

		httpTimeout = 12 * time.Second
	)

	type Proxy struct {
		IP   string
		Port string
		User string
		Pass string
	}

	proxies := []Proxy{
		// From free and from paid
		{"198.23.239.134", "6540", "nfvnhmgy", "9u32qq50gw96"},
		{"46.203.134.141", "5765", "zxhdqkjs", "pg023k71r8dv"},
	}

	workers := 1

	// precompute total tasks: rows * cols
	totalRows := (1000 - startY) + (endY + 1)
	totalCols := (xMax - xMin + 1)
	totalTasks := uint64(totalRows * totalCols)

	jobs := make(chan task, 4096)
	results := make(chan paintedByResult, 4096)
	failEv := make(chan failEvent, 4096) // per-attempt fail events

	// counters
	var okCount uint64           // completed successfully (per task)
	var lostCount uint64         // permanently failed (per task)
	var retryAttemptCount uint64 // number of retry attempts (per attempt, excludes successes)

	// recent reason buffers
	retryRB := newFailRing(512)
	lostRB := newFailRing(512)

	// producer
	go func() {
		defer close(jobs)
		tileY := startTileY
		y := startY
		for {
			for x := xMin; x <= xMax; x++ {
				jobs <- task{tileX: tileX, tileY: tileY, x: x, y: y}
			}
			y++
			if y >= 1000 {
				y = 0
				tileY++
			}
			if tileY == endTileY && y > endY {
				break
			}
		}
	}()

	// fan-in fail events to rings + counts
	doneFailSink := make(chan struct{})
	go func() {
		for fe := range failEv {
			if fe.final {
				atomic.AddUint64(&lostCount, 1)
				lostRB.add(fe)
			} else {
				atomic.AddUint64(&retryAttemptCount, 1)
				retryRB.add(fe)
			}
		}
		close(doneFailSink)
	}()

	// workers
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(workerID int) {
			defer wg.Done()

			// pick proxy for this worker
			proxy := proxies[workerID%len(proxies)]
			proxyURL := fmt.Sprintf("http://%s:%s@%s:%s/", proxy.User, proxy.Pass, proxy.IP, proxy.Port)

			useProxy := workerID%3 == 0

			pu, err := url.Parse(proxyURL)
			if err != nil {
				panic(err)
			}

			var client *http.Client

			if useProxy {
				client = &http.Client{
					Timeout: httpTimeout,
					Transport: &http.Transport{
						Proxy: http.ProxyURL(pu),
					},
				}
			} else {
				client = &http.Client{
					Timeout: httpTimeout,
				}
			}

			for t := range jobs {
				pbr, finalErr := fetchOne(client, baseURL, userAgent, cfClearance, jCookie, t, maxRetries, failEv)
				if finalErr != nil {
					continue
				}
				atomic.AddUint64(&okCount, 1)
				results <- *pbr
			}
		}(i)
	}

	// close results after workers finish, then close failEv
	doneResults := make(chan struct{})
	go func() {
		wg.Wait()
		close(results)
		close(failEv) // signal the fail sink to finish
		close(doneResults)
	}()

	// logger
	go func() {
		tick := time.NewTicker(logEvery)
		defer tick.Stop()

		var lastDone, lastRetries uint64
		start := time.Now()

		for {
			select {
			case <-tick.C:
				ok := atomic.LoadUint64(&okCount)
				lost := atomic.LoadUint64(&lostCount)
				retries := atomic.LoadUint64(&retryAttemptCount)

				done := ok + lost
				deltaDone := done - lastDone
				deltaRetries := retries - lastRetries
				lastDone, lastRetries = done, retries

				elapsed := time.Since(start).Seconds()
				qpsOverall := float64(done) / elapsed
				qpsWindow := float64(deltaDone) / logEvery.Seconds()

				fmt.Printf("[progress] %d/%d done (%.1f%%) ok=%d lost=%d retries=%d | ~%.1f req/s (%.1f window) | ETA %.1fh\n",
					done, totalTasks, float64(done)*100/float64(totalTasks),
					ok, lost, retries, qpsOverall, qpsWindow,
					(float64(totalTasks)-float64(done))/qpsOverall/3600,
				)

				// show a few recent retry reasons
				if deltaRetries > 0 {
					for _, fe := range retryRB.snapshot(3) {
						fmt.Printf("  retry: %s (attempt %d) (%s)\n", fe.reason, fe.attempt, fe.url)
					}
				}
				// show a few recent lost reasons
				if lost > 0 {
					for _, fe := range lostRB.snapshot(3) {
						fmt.Printf("  lost: %s (attempt %d) (%s)\n", fe.reason, fe.attempt, fe.url)
					}
				}

			case <-doneResults:
				// wait for fail sink to drain so counts are final
				<-doneFailSink
				ok := atomic.LoadUint64(&okCount)
				lost := atomic.LoadUint64(&lostCount)
				retries := atomic.LoadUint64(&retryAttemptCount)
				fmt.Printf("[final] ok=%d lost=%d retries=%d total=%d in %.1fs\n",
					ok, lost, retries, ok+lost, time.Since(start).Seconds(),
				)
				return
			}
		}
	}()

	// aggregate users while results stream
	agg := aggregate(results)

	// write file
	if err := writeJSON(outPath, agg); err != nil {
		fmt.Println("write error:", err)
		return
	}
	fmt.Println("wrote", outPath)
}

func buildURL(base string, t task) string {
	return fmt.Sprintf("%s/%d/%d?x=%d&y=%d", base, t.tileX, t.tileY, t.x, t.y)
}

// fetchOne performs up to (maxRetries+1) attempts.
// It emits a failEvent to failEv for each failed attempt.
// On success, returns result and nil error.
// On permanent failure after all attempts, returns nil and final error.
func fetchOne(client *http.Client, baseURL, userAgent, cfClearance, jCookie string, t task, maxRetries int, failEv chan<- failEvent) (*paintedByResult, error) {
	url := buildURL(baseURL, t)
	var lastErr error

	totalAttempts := maxRetries + 1
	for attempt := 0; attempt < totalAttempts; attempt++ {
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", userAgent)
		if cfClearance != "" || jCookie != "" {
			var b bytes.Buffer
			if cfClearance != "" {
				b.WriteString("cf_clearance=")
				b.WriteString(cfClearance)
			}
			if jCookie != "" {
				if b.Len() > 0 {
					b.WriteString("; ")
				}
				b.WriteString("j=")
				b.WriteString(jCookie)
			}
			req.Header.Set("Cookie", b.String())
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("request error: %w", err)
			failEv <- failEvent{url: url, reason: lastErr.Error(), attempt: attempt, final: attempt == totalAttempts-1}
			backoff(attempt)
			continue
		}

		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("read error: %w", readErr)
			failEv <- failEvent{url: url, reason: lastErr.Error(), attempt: attempt, final: attempt == totalAttempts-1}
			backoff(attempt)
			continue
		}

		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("http %d", resp.StatusCode)
			failEv <- failEvent{url: url, reason: lastErr.Error(), attempt: attempt, final: attempt == totalAttempts-1}
			backoff(attempt)
			continue
		}

		var pr PixelResponse
		if err := json.Unmarshal(body, &pr); err != nil {
			lastErr = fmt.Errorf("json error: %w", err)
			failEv <- failEvent{url: url, reason: lastErr.Error(), attempt: attempt, final: attempt == totalAttempts-1}
			backoff(attempt)
			continue
		}

		// success
		return &paintedByResult{
			user: pr.PaintedBy,
			at:   Coord{TileX: t.tileX, TileY: t.tileY, X: t.x, Y: t.y},
		}, nil
	}

	return nil, lastErr
}

func backoff(attempt int) {
	// 150ms, 300ms, 450ms, ... keep it gentle
	base := 150 * time.Millisecond
	time.Sleep(time.Duration(attempt+1) * base)
}

func aggregate(results <-chan paintedByResult) []UserCredits {
	byUser := make(map[int]*UserCredits)
	for r := range results {
		id := r.user.ID
		u := byUser[id]
		if u == nil {
			u = &UserCredits{ID: id, Name: r.user.Name}
			byUser[id] = u
		}
		u.Count++
		u.Coords = append(u.Coords, r.at)
	}
	out := make([]UserCredits, 0, len(byUser))
	for _, v := range byUser {
		out = append(out, *v)
	}
	return out
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dirOf(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func dirOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[:i]
		}
	}
	return "."
}
