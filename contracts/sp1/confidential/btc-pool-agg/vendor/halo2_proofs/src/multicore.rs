pub use rayon::{
    current_num_threads,
    iter::{IndexedParallelIterator, IntoParallelRefIterator},
    iter::{IntoParallelIterator, IntoParallelRefMutIterator, ParallelIterator},
    join, scope,
    slice::ParallelSliceMut,
    Scope,
};

pub trait TryFoldAndReduce<T, E> {
    /// Implements `iter.try_fold().try_reduce()` for `rayon::iter::ParallelIterator`,
    /// falling back on `Iterator::try_fold` when the `multicore` feature flag is
    /// disabled.
    /// The `try_fold_and_reduce` function can only be called by a iter with
    /// `Result<T, E>` item type because the `fold_op` must meet the trait
    /// bounds of both `try_fold` and `try_reduce` from rayon.   
    fn try_fold_and_reduce(
        self,
        identity: impl Fn() -> T + Send + Sync,
        fold_op: impl Fn(T, Result<T, E>) -> Result<T, E> + Send + Sync,
    ) -> Result<T, E>;
}

impl<T, E, I> TryFoldAndReduce<T, E> for I
where
    T: Send + Sync,
    E: Send + Sync,
    I: rayon::iter::ParallelIterator<Item = Result<T, E>>,
{
    fn try_fold_and_reduce(
        self,
        identity: impl Fn() -> T + Send + Sync,
        fold_op: impl Fn(T, Result<T, E>) -> Result<T, E> + Send + Sync,
    ) -> Result<T, E> {
        self.try_fold(&identity, &fold_op)
            .try_reduce(&identity, |a, b| fold_op(a, Ok(b)))
    }
}

/// Serial stand-ins used on the verifier path inside a single-threaded zkVM guest.
#[cfg(target_os = "zkvm")]
#[allow(missing_docs, missing_debug_implementations)]
pub mod serial {
    use core::marker::PhantomData;
    pub struct Scope<'a>(PhantomData<&'a ()>);
    impl<'a> Scope<'a> {
        pub fn spawn<F: FnOnce(&Scope<'a>) + 'a>(&self, f: F) {
            f(self)
        }
    }
    pub fn scope<'a, F: FnOnce(&Scope<'a>) -> R, R>(f: F) -> R {
        f(&Scope(PhantomData))
    }
    pub fn join<A: FnOnce() -> RA, B: FnOnce() -> RB, RA, RB>(a: A, b: B) -> (RA, RB) {
        (a(), b())
    }
    pub fn current_num_threads() -> usize {
        1
    }
    pub trait IntoParallelIterator: IntoIterator + Sized {
        fn into_par_iter(self) -> Self::IntoIter {
            self.into_iter()
        }
    }
    impl<T: IntoIterator> IntoParallelIterator for T {}
}
