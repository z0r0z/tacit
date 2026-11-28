export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/')) return nextResolve(new URL('../dapp' + specifier, import.meta.url).href, context);
  return nextResolve(specifier, context);
}
