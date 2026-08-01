<script lang="ts">
	import { resolve } from '$app/paths';
	import Affiche from '$lib/components/Affiche.svelte';
	import Grille from '$lib/components/Grille.svelte';
	import Jauge from '$lib/components/Jauge.svelte';
	import MaskedText from '$lib/components/MaskedText.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * Les rayons du journal, dans l'ordre où on les lit.
	 *
	 * L'abandon vient en dernier et n'est pas une quatrième étagère (R2) — mais
	 * ses affiches portent le liseré d'or comme les terminées, parce qu'une
	 * œuvre abandonnée **est atteinte** (R3). C'est l'endroit du produit où la
	 * distinction se voit le mieux : deux rayons différents, le même or.
	 */
	const RAYONS = [
		{ cle: 'en_cours' as const, titre: 'En cours' },
		{ cle: 'termine' as const, titre: 'Terminé' },
		{ cle: 'a_decouvrir' as const, titre: 'À découvrir' },
		{ cle: 'abandonne' as const, titre: 'Abandonné' }
	];

	function rayon(cle: (typeof RAYONS)[number]['cle']) {
		return cle === 'abandonne'
			? data.entrees.filter((entree) => entree.abandonnee)
			: data.entrees.filter((entree) => !entree.abandonnee && entree.etagere === cle);
	}

	/** R6 — les ordres créés et les ordres suivis sont deux listes, pas une. */
	const RAYONS_DORDRES = [
		{ cle: 'crees' as const, titre: 'Ordres écrits' },
		{ cle: 'suivis' as const, titre: 'Ordres suivis' }
	];

	const nom = $derived(data.membre.nom ?? 'un membre parti');

	/** Les avis écrits, masqués ou non — R31 les montre en tant qu'objets. */
	const avis = $derived(data.entrees.filter((entree) => entree.avis !== null));

	const revele = $derived(form !== null && 'revele' in form && form.revele === true);

	const atteintes = $derived(data.entrees.filter((entree) => entree.atteinte).length);
</script>

<svelte:head><title>Journal de {nom} — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
	<p class="enseigne">Journal</p>
	<h1 class="mt-1 font-display text-3xl leading-none tracking-tight sm:text-4xl">{nom}</h1>
	<p class="mt-2 text-sm text-encre-tenue">
		{data.entrees.length} œuvre{data.entrees.length > 1 ? 's' : ''} consignée{data.entrees.length >
		1
			? 's'
			: ''}
		· <span class="text-or">{atteintes} atteinte{atteintes > 1 ? 's' : ''}</span>
	</p>

	{#if data.entrees.length === 0}
		<p class="mt-10 text-sm text-encre-tenue">Rien de consigné pour l’instant.</p>
	{/if}

	{#each RAYONS as { cle, titre } (cle)}
		{@const entrees = rayon(cle)}
		{#if entrees.length > 0}
			<h2 class="mt-12 enseigne">{titre} ({entrees.length})</h2>
			<div class="mt-4">
				<Grille serree>
					{#each entrees as entree, rang (entree.entreeId)}
						<li>
							<Affiche
								titre={entree.oeuvre.titre}
								couvertureUrl={entree.oeuvre.couvertureUrl}
								href={resolve('/work/[id]', { id: entree.oeuvre.id })}
								etat={entree.atteinte ? 'atteint' : 'consigne'}
								note={entree.note}
								position={entree.position}
								{rang}
							/>
						</li>
					{/each}
				</Grille>
			</div>
		{/if}
	{/each}

	{#each RAYONS_DORDRES as { cle, titre } (cle)}
		{@const liste = data.ordres[cle]}
		{#if liste.length > 0}
			<h2 class="mt-12 enseigne">{titre}</h2>
			<ul class="mt-3 max-w-2xl border-t border-trait">
				{#each liste as ordre (ordre.id)}
					<li
						class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-trait py-3"
					>
						<span class="min-w-0">
							<a href={resolve('/order/[id]', { id: ordre.id })} class="lien text-sm"
								>{ordre.titre}</a
							>
							<span class="ml-2 text-xs text-encre-tenue">
								{ordre.nombreDEntrees} entrée{ordre.nombreDEntrees > 1 ? 's' : ''}
							</span>
						</span>
						<span class="w-40 shrink-0"><Jauge pourcentage={ordre.pourcentage} /></span>
					</li>
				{/each}
			</ul>
		{/if}
	{/each}

	{#if avis.length > 0}
		<h2 class="mt-12 enseigne">{data.soiMeme ? 'Ce que tu as écrit' : 'Ce qui a été écrit'}</h2>
		<ul class="mt-3 max-w-2xl divide-y divide-trait border-t border-trait">
			{#each avis as entree (entree.entreeId)}
				<li>
					<p class="pt-4">
						<a href={resolve('/work/[id]', { id: entree.oeuvre.id })} class="lien text-sm"
							>{entree.oeuvre.titre}</a
						>
					</p>
					{#if entree.avis}
						<!-- La même carte que partout ailleurs : masquée ou non, elle dit
						     qu'un avis existe et qui l'a écrit (R31). -->
						<MaskedText
							oeuvreId={entree.avis.oeuvreId}
							auteur={nom}
							note={entree.note}
							masque={entree.avis.masque}
							texte={entree.avis.texte}
							{revele}
						/>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
