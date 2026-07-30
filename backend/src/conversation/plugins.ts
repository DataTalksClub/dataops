import { StaticPluginRegistry } from './pluginRegistry';
import { loadTodoPluginArtifact, todoPluginDefinition } from './todoPlugin';

function createProductionPluginRegistry(
  config: { todoEnabled: boolean } = {
    todoEnabled: process.env.CONVERSATIONAL_TODO_PLUGIN_ENABLED === 'true',
  }
): StaticPluginRegistry {
  return new StaticPluginRegistry(
    [{ ...todoPluginDefinition, enabled: config.todoEnabled }],
    loadTodoPluginArtifact
  );
}

const productionPluginRegistry = createProductionPluginRegistry({ todoEnabled: false });

export {
  createProductionPluginRegistry,
  productionPluginRegistry,
};
