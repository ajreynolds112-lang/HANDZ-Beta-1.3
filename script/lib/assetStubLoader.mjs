// Node resolve hook for headless checks: Vite-only `@assets/...` media imports
// resolve to an empty module (they are only URLs in the browser).
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@assets/")) return { url: "data:text/javascript,export default ''", shortCircuit: true };
  return next(specifier, context);
}
