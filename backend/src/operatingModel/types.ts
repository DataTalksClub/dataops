export interface BusinessUnitDefinition {
  id: string;
  tag: string;
  name: string;
  role: string;
  revenueModel: string;
  priority: string;
  separationRule: string;
}

export interface FunctionDefinition {
  id: string;
  slug: string;
  name: string;
  managerRoleId: string;
  managerTitle: string;
  outcome: string;
  currentCoverage: string;
  documentationCoverage: string;
  documentId: string;
}

export interface SystemDefinition {
  id: string;
  title: string;
  functionId: string;
  managerRoleId: string;
  status: string;
  criticality: string;
  documentId: string;
  path: string;
}

export interface GapDefinition {
  id: string;
  priority: string;
  functionId: string;
  title: string;
  outcome: string;
  reason: string;
  businessUnits: string[];
  proposedSystemId: string;
  systemDocumentId: string | null;
  schedule: { kind: 'session'; sessionId: string } | { kind: 'deferred'; label: string };
  definitionStatus: string;
}

export interface RoadmapSessionDefinition {
  id: string;
  title: string;
  proposedDate: string;
  goal: string;
  deliverables: string;
  decisionsNeeded: string;
  agentWork: string;
  definitionOfDone: string;
  documentId: string;
  templateType: string;
  targetPaths: string;
}

export interface OperatingModelSnapshot {
  revision: string;
  loadedAt: string;
  freshness: 'current';
  overviewDocumentId: string;
  businessUnits: BusinessUnitDefinition[];
  functions: FunctionDefinition[];
  systems: SystemDefinition[];
  gaps: GapDefinition[];
  lifecycles: Array<{ id: string; title: string; path: string }>;
  roadmap: { id: '2026-q4'; sessions: RoadmapSessionDefinition[] };
  downloads: Array<{ id: string; label: string; href: string }>;
}
