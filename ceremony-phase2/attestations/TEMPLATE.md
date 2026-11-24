# Tacit Praxis ceremony: contribution #<index>

- **Contributor:** <name> (<handle>)
- **Index:** phase2-<index>
- **Contribution hash:** `<contribution_hash from receipt-<index>.json>`
- **Built on:** phase2-<index - 1>, sha256 `<prev_file_sha256>`
- **Receipt:** `receipt-<index>.json`, signed by coordinator key `c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7`

## Tool

- **Commit:** `<git rev-parse HEAD, or the vcs.revision that tacit-ceremony version prints>`
- **Binary:** built from source with `<go version>` | release binary `<file name>`, sha256 `<shasum -a 256 tacit-ceremony>`
- **`tacit-ceremony version`:** `<output>`

## Machine

- **Hardware:** <CPU, RAM; laptop / desktop / cloud instance (provider, type)>
- **OS:** <name and version>
- **Network during the contribution:** <online through the coordinator | offline (contribute-file), uploaded from another machine>

## Randomness and its disposal

- **Source:** the tool's own (Go crypto/rand, from the OS) | <anything you added>
- **Swap / hibernation:** <off | on>
- **Afterwards:** <process exited | machine powered off | disk wiped | instance destroyed (when)>
- **Anything else:** <e.g. who had access to the machine>

## Signature

The lines above, signed with a key that is already public and linked to you:

- **Method:** <PGP (key fingerprint) | SSH (`ssh-keygen -Y sign -n file`, key) | Ethereum (address, EIP-191) | a post from your account (link)>
- **Signature:**

```
<signature>
```
