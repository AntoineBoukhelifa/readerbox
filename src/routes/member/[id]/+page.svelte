<script lang="ts">
	import { resolve } from '$app/paths';
	import MaskedText from '$lib/components/MaskedText.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Les trois étagères de R1, dans l'ordre où on les lit. L'abandon est à part (R2). */
	const RAYONS = [
		{ etagere: 'en_cours' as const, titre: 'En cours' },
		{ etagere: 'termine' as const, titre: 'Terminé' },
		{ etagere: 'a_decouvrir' as const, titre: 'À découvrir' }
	];

	const abandonnees = $derived(data.entrees.filter((entree) => entree.abandonnee));

	function rayon(etagere: (typeof RAYONS)[number]['etagere']) {
		return data.entrees.filter((entree) => !entree.abandonnee && entree.etagere === etagere);
	}

	/** La note en étoiles, demi-étoiles comprises (R4). */
	function etoiles(note: number): string {
		return '★'.repeat(Math.floor(note)) + (note % 1 === 0.5 ? '½' : '');
	}

	const pourcentage = (position: number) => `${Math.round(position * 100)} %`;

	/** R20 — `null` désigne un ordre dont rien n'est essentiel, pas un zéro. */
	const avancement = (valeur: number | null) => (valeur === null ? '—' : `${valeur} %`);

	/** R6 — les ordres créés et les ordres suivis sont deux listes, pas une. */
	const RAYONS_DORDRES = [
		{ cle: 'crees' as const, titre: 'Ordres écrits' },
		{ cle: 'suivis' as const, titre: 'Ordres suivis' }
	];
</script>

<svelte:head><title>Journal de {data.membre.nom} — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">
		Journal de {data.membre.parti ? 'un membre parti' : data.membre.nom}
	</h1>

	{#if data.entrees.length === 0}
		<p class="mt-4 text-sm text-neutral-500">Rien de consigné pour l’instant.</p>
	{/if}

	{#each RAYONS as { etagere, titre } (etagere)}
		{@const entrees = rayon(etagere)}
		{#if entrees.length > 0}
			<h2 class="mt-10 text-sm font-semibold tracking-tight">{titre}</h2>
			<ul class="mt-2 divide-y divide-neutral-200">
				{#each entrees as entree (entree.entreeId)}
					<li class="py-3">
						<div class="flex items-baseline justify-between gap-4">
							<span class="text-sm font-medium">{entree.oeuvre.titre}</span>
							<span class="text-sm text-neutral-500">
								{#if entree.note !== null}{etoiles(entree.note)}{/if}
								{#if etagere === 'en_cours' && entree.position > 0}
									· {pourcentage(entree.position)}
								{/if}
							</span>
						</div>
						{#if entree.avis}
							<!-- La même carte que partout ailleurs : masquée ou non, elle dit
							     qu'un avis existe et qui l'a écrit (R31). -->
							<MaskedText
								oeuvreId={entree.avis.oeuvreId}
								auteur={data.membre.parti ? 'Un membre parti' : data.membre.nom}
								masque={entree.avis.masque}
								texte={entree.avis.texte}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/each}

	{#each RAYONS_DORDRES as { cle, titre } (cle)}
		{@const liste = data.ordres[cle]}
		{#if liste.length > 0}
			<h2 class="mt-10 text-sm font-semibold tracking-tight">{titre}</h2>
			<ul class="mt-2 divide-y divide-neutral-200">
				{#each liste as ordre (ordre.id)}
					<li class="flex items-baseline justify-between gap-4 py-3">
						<a
							href={resolve('/order/[id]', { id: ordre.id })}
							class="text-sm font-medium underline underline-offset-4">{ordre.titre}</a
						>
						<span class="text-sm whitespace-nowrap text-neutral-500">
							{ordre.nombreDEntrees} entrée{ordre.nombreDEntrees > 1 ? 's' : ''} · {avancement(
								ordre.pourcentage
							)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	{/each}

	{#if abandonnees.length > 0}
		<h2 class="mt-10 text-sm font-semibold tracking-tight">Abandonné</h2>
		<ul class="mt-2 divide-y divide-neutral-200">
			{#each abandonnees as entree (entree.entreeId)}
				<li class="flex items-baseline justify-between gap-4 py-3">
					<span class="text-sm font-medium">{entree.oeuvre.titre}</span>
					{#if entree.note !== null}
						<span class="text-sm text-neutral-500">{etoiles(entree.note)}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
