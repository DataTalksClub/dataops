import { StaticPluginRegistry } from './pluginRegistry';

// Domain plugins are registered by later issue slices. Keeping this explicit and
// empty makes the disabled M2 runtime incapable of proposing or executing work.
const productionPluginRegistry = new StaticPluginRegistry([]);

export { productionPluginRegistry };
