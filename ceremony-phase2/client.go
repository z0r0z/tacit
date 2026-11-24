package ceremony

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// Remote contribution, the contributor's side: join the queue, wait for the slot, download the head and check its
// SHA-256 against what the coordinator says, contribute locally, upload, and return the signed receipt.
func ContributeRemote(base, name, handle, workdir string, poll time.Duration, log func(string)) (*Receipt, error) {
	if log == nil {
		log = func(string) {}
	}
	body, _ := json.Marshal(map[string]string{"name": name, "handle": handle})
	var join struct {
		Token string
		Ahead int
		Error string
	}
	if err := postJSON(base+"/api/join", body, &join); err != nil || join.Token == "" {
		return nil, fmt.Errorf("could not join: %v %s", err, join.Error)
	}
	log(fmt.Sprintf("in the queue, %d ahead", join.Ahead))
	for {
		var s struct {
			Yours bool
			Ahead int
			Error string
		}
		if err := getJSON(base+"/api/slot?token="+url.QueryEscape(join.Token), &s); err != nil {
			return nil, fmt.Errorf("lost the place in the queue: %v %s", err, s.Error)
		}
		if s.Yours {
			break
		}
		time.Sleep(poll)
	}
	var head struct {
		Index  int
		SHA256 string
		URL    string
	}
	if err := getJSON(base+"/api/head", &head); err != nil {
		return nil, err
	}
	in := filepath.Join(workdir, fmt.Sprintf("phase2-%d", head.Index))
	log(fmt.Sprintf("downloading the head, phase2-%d", head.Index))
	if err := download(base+head.URL, in); err != nil {
		return nil, err
	}
	if sum, err := FileSHA256(in); err != nil || sum != head.SHA256 {
		return nil, errors.New("the downloaded head does not match the coordinator's SHA-256")
	}
	out := filepath.Join(workdir, fmt.Sprintf("phase2-%d", head.Index+1))
	log("contributing (fresh randomness, discarded when this program exits)")
	if _, err := Contribute(in, out); err != nil {
		return nil, err
	}
	log("uploading")
	f, err := os.Open(out)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	req, _ := http.NewRequest(http.MethodPut, base+"/api/upload?token="+url.QueryEscape(join.Token), f)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("the contribution was refused: %s", bytes.TrimSpace(b))
	}
	var r Receipt
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func getJSON(u string, v any) error {
	resp, err := http.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func postJSON(u string, body []byte, v any) error {
	resp, err := http.Post(u, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func download(u, path string) error {
	resp, err := http.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d for %s", resp.StatusCode, u)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
