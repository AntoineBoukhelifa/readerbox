<script lang="ts">
	import { onMount } from 'svelte';
	import type { Core, ElementDefinition, StylesheetJson } from 'cytoscape';
	import type { GrapheRendu } from '$lib/graph/rendu';

	/**
	 * Le rendu du graphe, avec Cytoscape.js (KTD7).
	 *
	 * **Rien n'est décidé ici.** Le composant reçoit un graphe déjà filtré et se
	 * contente de le dessiner : ni masquage, ni projection, ni règle. C'est ce qui
	 * fait qu'aucune arête ne peut apparaître à l'écran sans être passée par la
	 * table matérialisée de U9 — R52 n'a pas de porte de sortie côté navigateur.
	 *
	 * **Cytoscape est chargé à l'exécution, dans le navigateur seulement.** Il
	 * mesure le conteneur au démarrage et n'a donc rien à faire pendant le rendu
	 * serveur ; l'import dynamique évite en plus de le mettre dans le lot initial,
	 * ce que les 250 ko de la bibliothèque justifient à eux seuls.
	 */
	interface Props {
		graphe: GrapheRendu;
		/** Le nœud ouvert, mis en évidence. */
		selection: string | null;
		/** Ce que la surface fait quand on ouvre un nœud (R53). */
		onouvrir: (entiteId: string) => void;
	}

	let { graphe, selection, onouvrir }: Props = $props();

	let conteneur: HTMLDivElement;
	let cy: Core | null = $state(null);

	/**
	 * Le choix de disposition, par taille.
	 *
	 * `cose` est une disposition par forces : elle donne la lecture la plus juste
	 * — les grappes se voient — et son coût croît vite. Au-delà de quelques
	 * centaines de nœuds elle fait attendre pour un résultat que personne ne
	 * démêle de toute façon ; `concentric`, qui range par degré, y reste lisible
	 * et se calcule en un passage.
	 */
	const SEUIL_DISPOSITION_PAR_FORCES = 300;

	function elements(vue: GrapheRendu): ElementDefinition[] {
		return [
			...vue.noeuds.map((noeud) => ({
				group: 'nodes' as const,
				data: {
					id: noeud.id,
					nom: noeud.nom,
					dimension: noeud.dimension,
					// Le poids d'un nœud est le nombre d'œuvres atteintes qui l'ont
					// établi : c'est ce qui fait ressortir le nœud très connecté et
					// inattendu que F6 vient chercher.
					taille: 14 + Math.min(26, Math.sqrt(noeud.oeuvres) * 6)
				}
			})),
			...vue.aretes.map((arete) => ({
				group: 'edges' as const,
				data: {
					id: `${arete.source}~${arete.cible}`,
					source: arete.source,
					target: arete.cible,
					epaisseur: Math.min(6, 1 + Math.log2(arete.poids + 1))
				}
			}))
		];
	}

	/**
	 * La palette est celle de la salle obscure, et elle y obéit à la même règle
	 * qu'ailleurs : **l'or ne désigne que l'état.** Ici, l'état est le nœud
	 * ouvert — celui que le membre est en train de regarder. Les trois
	 * dimensions, elles, se distinguent par la **forme** autant que par la
	 * clarté : un graphe qui ne se lirait qu'en couleur ne se lirait pas du tout
	 * pour qui les distingue mal.
	 *
	 * Les valeurs sont écrites en dur plutôt que lues du thème : Cytoscape
	 * dessine dans un canevas, où les variables CSS n'existent pas. Elles
	 * reprennent `--color-encre`, `--color-encre-basse`, `--color-trait` et
	 * `--color-or` de `layout.css`, et doivent bouger avec elles.
	 */
	const SALLE = '#2a2621';
	const ENCRE = '#f0e9e0';
	const ENCRE_BASSE = '#b5aca0';
	const TRAIT = '#4b463f';
	const OR = '#e0a63a';

	const STYLE: StylesheetJson = [
		{
			selector: 'node',
			style: {
				'background-color': ENCRE_BASSE,
				width: 'data(taille)',
				height: 'data(taille)',
				label: 'data(nom)',
				'font-size': '10px',
				'font-family': "'IBM Plex Sans Variable', ui-sans-serif, system-ui, sans-serif",
				color: ENCRE_BASSE,
				'text-valign': 'bottom',
				'text-margin-y': 3,
				// Un liseré de fond derrière le texte : un graphe dense empile les
				// libellés sur les traits, et un nom illisible ne désigne rien.
				'text-outline-color': SALLE,
				'text-outline-width': 2,
				'min-zoomed-font-size': 8
			}
		},
		{ selector: 'node[dimension = "personnage"]', style: { 'background-color': ENCRE } },
		{
			selector: 'node[dimension = "serie"]',
			style: { 'background-color': ENCRE_BASSE, shape: 'round-rectangle' }
		},
		{
			selector: 'node[dimension = "event"]',
			style: {
				'background-color': TRAIT,
				'border-width': 1,
				'border-color': ENCRE,
				shape: 'diamond'
			}
		},
		{
			selector: 'node.ouvert',
			style: {
				'background-color': OR,
				'border-width': 3,
				'border-color': OR,
				color: OR,
				'font-weight': 'bold'
			}
		},
		{
			selector: 'edge',
			style: {
				width: 'data(epaisseur)',
				'line-color': TRAIT,
				'curve-style': 'haystack',
				opacity: 0.9
			}
		}
	];

	function disposition(taille: number) {
		return taille > SEUIL_DISPOSITION_PAR_FORCES
			? { name: 'concentric', animate: false, minNodeSpacing: 12 }
			: { name: 'cose', animate: false, nodeRepulsion: 6000, idealEdgeLength: 60 };
	}

	onMount(() => {
		let vivant = true;
		let instance: Core | null = null;

		void import('cytoscape').then(({ default: cytoscape }) => {
			// La page a pu être quittée pendant le chargement du module : monter
			// alors laisserait une instance sans démontage.
			if (!vivant) return;

			instance = cytoscape({
				container: conteneur,
				elements: elements(graphe),
				style: STYLE,
				layout: disposition(graphe.noeuds.length),
				wheelSensitivity: 0.2
			});
			instance.on('tap', 'node', (evenement) => onouvrir(evenement.target.id()));
			cy = instance;
		});

		return () => {
			vivant = false;
			instance?.destroy();
			cy = null;
		};
	});

	/**
	 * Le graphe filtré change sans que la page recharge : c'est tout l'intérêt du
	 * filtrage côté navigateur. Les éléments sont remplacés et la disposition
	 * relancée, plutôt que l'instance recréée — recréer perdrait le zoom et le
	 * cadrage, donc l'endroit que le membre était en train de regarder.
	 */
	$effect(() => {
		const instance = cy;
		if (!instance) return;

		const vue = graphe;
		instance.batch(() => {
			instance.elements().remove();
			instance.add(elements(vue));
		});
		instance.layout(disposition(vue.noeuds.length)).run();
	});

	$effect(() => {
		const instance = cy;
		if (!instance) return;

		const ouvert = selection;
		instance.nodes().removeClass('ouvert');
		if (ouvert !== null) instance.getElementById(ouvert).addClass('ouvert');
	});
</script>

<div
	bind:this={conteneur}
	class="h-[32rem] w-full border border-trait bg-cimaise"
	role="application"
	aria-label="Le graphe de ce que tu as atteint"
></div>

{#if graphe.noeuds.length > 0}
	<p class="mt-2 text-xs text-encre-tenue">
		{graphe.noeuds.length} nœud{graphe.noeuds.length > 1 ? 's' : ''} · {graphe.aretes.length} lien{graphe
			.aretes.length > 1
			? 's'
			: ''} · clique un nœud pour l’ouvrir.
	</p>
{/if}
