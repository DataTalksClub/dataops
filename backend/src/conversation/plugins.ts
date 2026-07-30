import { StaticPluginRegistry } from './pluginRegistry';
import { loadTodoPluginArtifact, todoPluginDefinition } from './todoPlugin';
import {
  loadTypefullyPluginArtifact,
  typefullyPluginDefinition,
} from './typefullyPlugin';

function createProductionPluginRegistry(
  config: { todoEnabled: boolean; typefullyEnabled?: boolean } = {
    todoEnabled: process.env.CONVERSATIONAL_TODO_PLUGIN_ENABLED === 'true',
    typefullyEnabled: process.env.CONVERSATIONAL_TYPEFULLY_PLUGIN_ENABLED === 'true',
  }
): StaticPluginRegistry {
  return new StaticPluginRegistry(
    [
      { ...todoPluginDefinition, enabled: config.todoEnabled },
      { ...typefullyPluginDefinition, enabled: config.typefullyEnabled === true },
    ],
    (artifactId) => {
      if (artifactId === todoPluginDefinition.buildArtifactId) {
        return loadTodoPluginArtifact(artifactId);
      }
      return loadTypefullyPluginArtifact(artifactId);
    }
  );
}

const productionPluginRegistry = createProductionPluginRegistry({
  todoEnabled: false,
  typefullyEnabled: false,
});

export {
  createProductionPluginRegistry,
  productionPluginRegistry,
};
