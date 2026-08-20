import { registerRoot } from "remotion";
// Extensionless, unlike this repo's usual ".js"-suffixed relative imports
// (see providers/scrapling/index.ts) - deliberate exception. Everything
// under composition/ is bundled by Remotion's own webpack-based bundle()
// (providers/remotion/render.ts), a different resolver from the tsx/Node
// ESM loader the rest of this repo runs under: webpack's default
// extensions list resolves a bare "./Root" to Root.tsx directly, but does
// NOT remap a literal ".js" specifier onto a same-named .tsx file the way
// tsx's loader does - an explicit ".js" suffix here would 404 in webpack.
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
