<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { EtatDAffiche } from '$lib/affichage';
	import Etoiles from './Etoiles.svelte';

	/**
	 * L'affiche — l'objet central de l'interface, et le seul endroit saturé de
	 * l'écran.
	 *
	 * Tout le reste du produit s'efface pour que soixante ans de couvertures
	 * incompatibles tiennent côte à côte. C'est aussi la seule « carte » du
	 * produit, et elle l'est parce qu'**elle est l'interaction** : on clique
	 * l'affiche pour ouvrir l'œuvre. Rien d'autre ici n'est encadré.
	 *
	 * **L'état se lit avant le titre.** Deux marques, et deux seulement :
	 *
	 * - le carré plein en or et le liseré : l'œuvre est **atteinte** — terminée
	 *   ou abandonnée. C'est le seul état qui donne droit de voir, qui fait
	 *   avancer un ordre et qui alimente le graphe.
	 * - le carré vide : l'œuvre est **consignée** — posée sur une étagère — et
	 *   pas atteinte. À découvrir, ou en cours.
	 *
	 * Rien du tout : elle n'est sur aucune étagère. La distinction ne repose
	 * jamais sur la seule couleur — la marque a une forme, et un texte la
	 * double pour les lecteurs d'écran.
	 */
	interface Props {
		titre: string;
		couvertureUrl?: string | null;
		/** `null` quand l'œuvre n'est pas encore au catalogue : rien à ouvrir. */
		href?: string | null;
		/** La ligne de situation : série, rang, année. */
		situation?: string | null;
		etat?: EtatDAffiche;
		/** Ma note, quand la surface en montre une. */
		note?: number | null;
		/**
		 * Où en est la lecture, dans [0, 1] — la barre de progression du bas.
		 * Une œuvre atteinte est pleine par construction (R24).
		 */
		position?: number;
		/** Le rang dans la grille : c'est lui qui décale l'apparition. */
		rang?: number;
		/** Ce qui vient sous l'affiche : gestes de consignation, mentions. */
		children?: Snippet;
	}

	let {
		titre,
		couvertureUrl = null,
		href = null,
		situation = null,
		etat = 'aucun',
		note = null,
		position = 0,
		rang = 0,
		children
	}: Props = $props();

	/**
	 * Le décalage d'apparition est plafonné à douze rangs.
	 *
	 * Une grille de recherche en rend quarante : à trente-cinq millisecondes le
	 * rang, la dernière attendrait une seconde et demie. Passé le plafond, les
	 * suivantes entrent ensemble — on garde le mouvement de vague sans faire
	 * attendre le bas de l'écran.
	 */
	const decalage = $derived(Math.min(rang, 12));

	const remplissage = $derived(etat === 'atteint' ? 1 : Math.max(0, Math.min(1, position)));

	const DITS: Record<EtatDAffiche, string> = {
		atteint: 'Atteinte',
		consigne: 'Consignée, pas encore atteinte',
		aucun: 'Sur aucune de tes étagères'
	};
</script>

<article class="group flex apparait flex-col" style="--rang: {decalage}">
	<svelte:element
		this={href ? 'a' : 'div'}
		href={href ?? undefined}
		class="relative block transition-transform duration-150 ease-[var(--ease-franche)]
			{href ? 'group-hover:-translate-y-1.5 focus-visible:-translate-y-1.5' : ''}"
	>
		<!--
			Mouvement 2 — l'élévation au survol est nette : un déplacement court,
			un liseré franc, aucune ombre molle. La couverture ne flotte pas, elle
			se détache.
		-->
		<div
			class="relative aspect-[2/3] w-full overflow-hidden bg-cimaise outline-offset-0
				{etat === 'atteint'
				? 'outline-2 outline-or'
				: etat === 'consigne'
					? 'outline-1 outline-or-sourd'
					: ''}
				{href ? 'group-hover:outline-1 group-hover:outline-encre' : ''}"
		>
			<!--
				Le titre est **sous** la couverture, toujours, et pas seulement quand
				il n'y en a pas : une source rend parfois une adresse d'image qui ne
				répond plus, et une case grise au milieu d'une grille se lit comme un
				produit cassé. Il n'y a pas de script pour rattraper une image morte,
				il y a le titre en dessous d'elle.
			-->
			<p
				class="absolute inset-0 flex items-end p-2 font-display text-sm leading-tight break-words
					text-encre-tenue uppercase"
			>
				{titre}
			</p>

			{#if couvertureUrl}
				<img
					src={couvertureUrl}
					alt=""
					loading="lazy"
					class="relative h-full w-full object-cover"
					decoding="async"
				/>
			{/if}

			{#if etat !== 'aucun'}
				<span
					class="absolute top-0 right-0 flex size-6 items-center justify-center text-[0.8rem]
						{etat === 'atteint' ? 'bg-or text-salle' : 'bg-salle text-or-sourd'}"
				>
					{etat === 'atteint' ? '✓' : '○'}
					<span class="sr-only">{DITS[etat]}</span>
				</span>
			{/if}

			<!--
				La barre du bas. Pleine en or pour une œuvre atteinte, à la position
				déclarée pour une lecture en cours, absente sinon.
			-->
			{#if remplissage > 0}
				<span
					class="absolute bottom-0 left-0 h-1"
					class:bg-or={etat === 'atteint'}
					class:bg-or-sourd={etat !== 'atteint'}
					style="width: {remplissage * 100}%"
					aria-hidden="true"
				></span>
			{/if}
		</div>
	</svelte:element>

	<h3 class="mt-2 text-sm leading-tight {etat === 'atteint' ? 'text-or' : 'text-encre'}">
		{#if href}
			<!--
				La destination arrive résolue : les appelants la construisent tous
				par `resolve`, et la règle ne peut pas le voir depuis ici. La lui
				faire repasser demanderait de réécrire à la main un chemin qu'on a
				déjà sous la forme juste.
			-->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a {href} class="transition-colors hover:text-or">{titre}</a>
		{:else}
			{titre}
		{/if}
	</h3>

	{#if situation}
		<p class="mt-0.5 text-xs leading-tight text-encre-tenue">{situation}</p>
	{/if}

	{#if note !== null}
		<p class="mt-1 text-xs"><Etoiles valeur={note} /></p>
	{/if}

	{@render children?.()}
</article>
