// Hermes Satellite docs search index.
// hrefs are relative to docs/docs/ — each page sets window.DOCS_BASE ('./' or '../') before loading this.
// Rule: only list destinations that exist on disk. Add entries in the same commit that adds the page.
window.DOCS_INDEX = [
  { title: 'Dispatch a task', section: 'Execution', href: './' },
  { title: 'Overview', section: 'Dispatch a task', href: './#overview' },
  { title: 'Dispatching over MCP', section: 'Dispatch a task', href: './#dispatch' },
  { title: 'Polling to a terminal state', section: 'Dispatch a task', href: './#poll' },
  { title: 'Next steps', section: 'Dispatch a task', href: './#next' },
  { title: 'Hermes Satellite home', section: 'Site', href: '../' },
  { title: 'Introduction', section: 'Getting started', href: './introduction/' },
  { title: 'Install & connect', section: 'Getting started', href: './install/' },
  { title: 'Your first dispatch', section: 'Getting started', href: './first-dispatch/' },
  { title: 'Poll for status', section: 'Execution', href: './poll/' },
  { title: 'Fetch transcript', section: 'Execution', href: './transcript/' },
  { title: 'Shared machine', section: 'Execution', href: './shared-machine/' },
  { title: 'Decompose claims', section: 'Verification', href: './decompose/' },
  { title: 'Evidence & outcomes', section: 'Verification', href: './evidence/' },
  { title: 'Confidence tiers', section: 'Verification', href: './confidence/' },
];
