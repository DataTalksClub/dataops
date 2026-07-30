import { StaticPluginRegistry } from './pluginRegistry';
import { loadTodoPluginArtifact, todoPluginDefinition } from './todoPlugin';
import {
  loadTypefullyPluginArtifact,
  typefullyPluginDefinition,
} from './typefullyPlugin';
import { conversationalRolloutSnapshot } from './rollout';

function createProductionPluginRegistry(
  config: { todoEnabled: boolean; typefullyEnabled?: boolean } = {
    todoEnabled: conversationalRolloutSnapshot().eligibility.todoVisible,
    typefullyEnabled: conversationalRolloutSnapshot().eligibility.typefullyVisible,
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
