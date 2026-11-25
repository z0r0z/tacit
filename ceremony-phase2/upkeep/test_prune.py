import sys, os, unittest
sys.path.insert(0, os.path.dirname(__file__))
from prune import eligible

def st(head, base=17, extra=()):
    r = [{"index": i, "file_sha256": f"h{i}"} for i in range(base + 1, head + 1)]
    return {"head_index": head, "base_index": base, "receipts": [x for x in r if x["index"] not in extra]}

def mir(idx, wrong=()):
    return {str(i): {"sha256": ("bad" if i in wrong else f"h{i}"), "cid": f"Qm{i}"} for i in idx}

class T(unittest.TestCase):
    def test_deletes_old_mirrored_files_only(self):
        s = st(30)
        self.assertEqual(eligible(s, mir(range(18, 31)), list(range(17, 31)), 3), list(range(18, 28)))
    def test_never_the_base_the_head_or_the_newest(self):
        s = st(30)
        got = eligible(s, mir(range(17, 31)), list(range(17, 31)), 3)
        self.assertNotIn(17, got); self.assertNotIn(30, got); self.assertNotIn(29, got); self.assertNotIn(28, got)
    def test_not_without_the_mirror(self):
        s = st(30)
        self.assertEqual(eligible(s, mir([18, 19]), list(range(17, 31)), 3), [18, 19])
        self.assertEqual(eligible(s, {}, list(range(17, 31)), 3), [])
    def test_not_when_the_mirror_holds_other_bytes(self):
        s = st(30)
        self.assertEqual(eligible(s, mir(range(18, 31), wrong=(20,)), list(range(17, 31)), 3), [i for i in range(18, 28) if i != 20])
    def test_not_without_a_receipt(self):
        s = st(30, extra=(22,))
        self.assertNotIn(22, eligible(s, mir(range(18, 31)), list(range(17, 31)), 3))
    def test_only_files_that_exist(self):
        s = st(30)
        self.assertEqual(eligible(s, mir(range(18, 31)), [26, 27, 29, 30], 3), [26, 27])

if __name__ == "__main__":
    unittest.main()
