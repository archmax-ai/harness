// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { archmaxTheme } from '@archmax-ai/starlight-theme';

// https://astro.build/config
export default defineConfig({
	// GitHub Pages with a custom domain (docs/public/CNAME), served at the root.
	site: 'https://harness.archmax.ai',
	integrations: [
		starlight({
			plugins: [
				archmaxTheme({
					product: 'harness',
					tagline: 'A governed runtime for LangChain Deep Agents',
					links: { github: 'https://github.com/archmax-ai/harness' },
				}),
			],
			title: 'archmax harness',
			description:
				'A generic, backend-driven agent runtime built on LangChain Deep Agents, governed by a declarative workflow state machine.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/archmax-ai/harness' },
			],
			editLink: {
				baseUrl: 'https://github.com/archmax-ai/harness/edit/main/docs/',
			},
			customCss: ['./src/styles/custom.css'],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'The workflow machine', slug: 'guides/workflow-machine' },
						{ label: 'The authoring plane', slug: 'guides/authoring-plane' },
						{ label: 'Triggers', slug: 'guides/triggers' },
						{ label: 'Skills', slug: 'guides/skills' },
						{ label: 'Grading rubrics', slug: 'guides/grading-rubrics' },
						{ label: 'Sub-workflows', slug: 'guides/sub-workflows' },
						{ label: 'Code interpreter', slug: 'guides/code-interpreter' },
						{ label: 'Using the CLI', slug: 'guides/cli' },
						{ label: 'Testing workflows', slug: 'guides/testing' },
						{ label: 'Token efficiency and cost', slug: 'guides/token-efficiency' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Configuration', slug: 'reference/configuration' },
						{ label: 'CLI reference', slug: 'reference/cli' },
						{ label: 'Machine spec', slug: 'reference/machine-spec' },
						{ label: 'Glossary', slug: 'reference/glossary' },
						{ label: 'Public API', slug: 'reference/public-api' },
						{ label: 'Changelog', slug: 'reference/changelog' },
					],
				},
				{
					label: 'Contributing',
					items: [
						{ label: 'Development setup', slug: 'contributing/development' },
						{ label: 'The OpenSpec workflow', slug: 'contributing/openspec' },
					],
				},
			],
		}),
	],
});
