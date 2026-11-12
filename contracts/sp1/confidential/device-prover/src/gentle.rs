// How gently the salt grinder treats the computer it runs on. By default it grinds on a quarter of the cores (TACIT_SALT_THREADS changes that; 0 is off), at the lowest
// scheduling priority so whatever the person is doing comes first (on Apple silicon the system then keeps these threads on the efficiency cores), and not at all on
// battery (TACIT_SALT_BATTERY=1 grinds on battery too). TACIT_SALT_PRIORITY=normal keeps normal priority. Only the grinding threads are lowered: proving is not.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static ON_BATTERY: AtomicBool = AtomicBool::new(false);
pub fn set_on_battery(b: bool) { ON_BATTERY.store(b, Ordering::Relaxed); }
pub fn on_battery() -> bool { ON_BATTERY.load(Ordering::Relaxed) }

pub fn default_threads(cores: usize) -> usize { (cores / 4).max(1) }

// Grind only with an address to credit, with no proof running, and plugged in unless the person allowed battery.
pub fn grind_allowed(has_miner: bool, proving: bool, on_battery: bool, allow_battery: bool) -> bool { has_miner && !proving && (allow_battery || !on_battery) }
// Why it is not grinding now, for GET /mine.
pub fn paused_for(has_miner: bool, proving: bool, on_battery: bool, allow_battery: bool) -> Option<&'static str> {
    if !has_miner { Some("not mining") } else if proving { Some("proving") } else if on_battery && !allow_battery { Some("battery") } else { None }
}
pub fn allow_battery() -> bool {
    static A: OnceLock<bool> = OnceLock::new();
    *A.get_or_init(|| std::env::var("TACIT_SALT_BATTERY").map(|v| v == "1").unwrap_or(false))
}
pub fn background_wanted() -> bool {
    static B: OnceLock<bool> = OnceLock::new();
    *B.get_or_init(|| std::env::var("TACIT_SALT_PRIORITY").map(|v| v != "normal").unwrap_or(true))
}

#[cfg(target_os = "macos")]
mod sys {
    extern "C" { pub fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32; }
}
#[cfg(target_os = "linux")]
mod sys {
    extern "C" { pub fn setpriority(which: i32, who: u32, prio: i32) -> i32; }
}

// Puts the CALLING thread at the lowest priority; true when the system accepted it. macOS: the background quality-of-service class (this thread only, and the
// system keeps it off the performance cores). Linux: nice 19, which Linux keeps per thread (setpriority on "this process" with id 0 is the calling thread).
pub fn lower_priority() -> bool {
    if cfg!(target_os = "macos") { return macos_background(); }
    if cfg!(target_os = "linux") { return linux_nice(); }
    false
}
#[cfg(target_os = "macos")]
fn macos_background() -> bool { unsafe { sys::pthread_set_qos_class_self_np(0x09, 0) == 0 } }   // QOS_CLASS_BACKGROUND
#[cfg(not(target_os = "macos"))]
fn macos_background() -> bool { false }
#[cfg(target_os = "linux")]
fn linux_nice() -> bool { unsafe { sys::setpriority(0, 0, 19) == 0 } }   // PRIO_PROCESS, the calling thread
#[cfg(not(target_os = "linux"))]
fn linux_nice() -> bool { false }

#[cfg(test)]
mod tests {
    use super::*;

    // read-back calls, only for the tests
    #[cfg(target_os = "macos")]
    extern "C" {
        fn pthread_get_qos_class_np(thread: *mut std::ffi::c_void, qos_class: *mut u32, relative_priority: *mut i32) -> i32;
        fn pthread_self() -> *mut std::ffi::c_void;
    }
    #[cfg(target_os = "linux")]
    extern "C" { fn getpriority(which: i32, who: u32) -> i32; }

    #[test]
    fn a_quarter_of_the_cores_and_never_none() {
        let t: Vec<usize> = [1, 2, 3, 4, 7, 8, 10, 12, 16, 32].iter().map(|&c| default_threads(c)).collect();
        assert_eq!(t, [1, 1, 1, 1, 1, 2, 2, 3, 4, 8]);
    }

    #[test]
    fn it_grinds_only_with_an_address_and_no_proof_and_not_on_battery() {
        for has in [false, true] { for proving in [false, true] { for bat in [false, true] { for allow in [false, true] {
            let want = has && !proving && (!bat || allow);
            assert_eq!(grind_allowed(has, proving, bat, allow), want, "miner {has} proving {proving} battery {bat} allowed {allow}");
            assert_eq!(paused_for(has, proving, bat, allow).is_none(), want, "the reason is given exactly when it is paused");
        } } } }
        assert_eq!(paused_for(false, true, true, false), Some("not mining"), "no address wins over the rest");
        assert_eq!(paused_for(true, true, true, false), Some("proving"), "a proof wins over battery");
        assert_eq!(paused_for(true, false, true, false), Some("battery"));
        assert_eq!(paused_for(true, false, true, true), None, "battery allowed");
    }

    #[test]
    fn the_battery_flag_is_remembered() {
        set_on_battery(true); assert!(on_battery());
        set_on_battery(false); assert!(!on_battery());
    }

    // The lowered thread reports the background class; the thread that asked, and a thread nobody touched, do not.
    #[cfg(target_os = "macos")]
    #[test]
    fn only_the_thread_that_asked_is_put_in_the_background() {
        let class = || unsafe { let (mut q, mut r) = (0u32, 0i32); assert_eq!(pthread_get_qos_class_np(pthread_self(), &mut q, &mut r), 0); q };
        let before = class();
        assert_ne!(before, 0x09, "this test thread starts out of the background class");
        let lowered = std::thread::spawn(move || { let ok = lower_priority(); (ok, class()) }).join().unwrap();
        assert_eq!(lowered, (true, 0x09), "the grinding thread is in the background class");
        let other = std::thread::spawn(class).join().unwrap();
        assert_ne!(other, 0x09, "a thread that did not ask is not");
        assert_eq!(class(), before, "and this one is as it was");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_the_thread_that_asked_gets_nice_19() {
        let nice = || unsafe { getpriority(0, 0) };
        let before = nice();
        assert!(before < 19, "this test thread does not start at the lowest priority");
        let lowered = std::thread::spawn(move || { let ok = lower_priority(); (ok, nice()) }).join().unwrap();
        assert_eq!(lowered, (true, 19));
        assert_eq!(std::thread::spawn(nice).join().unwrap(), before, "a thread that did not ask keeps its priority");
        assert_eq!(nice(), before);
    }
}
