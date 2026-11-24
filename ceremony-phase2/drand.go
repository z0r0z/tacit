// Adapted from github.com/succinctlabs/semaphore-gnark-11 (drand.go), Apache License 2.0. Kept byte-compatible with its files.
package ceremony

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const DefaultAPIURL = "https://api.drand.sh"

type publicResponse struct {
	Round      uint64 `json:"round"`
	Randomness string `json:"randomness"`
}

func DrandRandomness(round uint64) ([]byte, error) {
	if round == 0 {
		return nil, errors.New("drand round must be > 0")
	}

	baseURL := strings.TrimRight(os.Getenv("DRAND_API_URL"), "/")
	if baseURL == "" {
		baseURL = DefaultAPIURL
	}

	url := fmt.Sprintf("%s/public/%d", baseURL, round)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("fetch drand round %d: %w", round, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("drand response %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload publicResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode drand response: %w", err)
	}
	if payload.Round != 0 && payload.Round != round {
		return nil, fmt.Errorf("drand round mismatch: requested %d got %d", round, payload.Round)
	}
	if payload.Randomness == "" {
		return nil, errors.New("drand response missing randomness")
	}

	randomness := strings.TrimPrefix(payload.Randomness, "0x")
	if randomness == "" {
		return nil, errors.New("drand randomness is empty")
	}
	out, err := hex.DecodeString(randomness)
	if err != nil {
		return nil, fmt.Errorf("decode drand randomness: %w", err)
	}
	return out, nil
}
