<script lang="ts">
	import { resolve } from '$app/paths';
	import MaskedText from '$lib/components/MaskedText.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** La note en étoiles, demi-étoiles comprises (R4). */
	function etoiles(note: number): string {
		return '★'.repeat(Math.floor(note)) + (note % 1 === 0.5 ? '½' : '');
	}

	const pourcentage = (position: number) => `${Math.round(position * 100)} %`;

	/** R26 — qui l’a atteinte, et qui est en route. */
	const arrives = $derived(data.lecteurs.filter((lecteur) => lecteur.atteinte));
	const enRoute = $derived(
		data.lecteurs.filter((lecteur) => !lecteur.atteinte && lecteur.etagere === 'en_cours')
	);
</script>

<svelte:head><title>{data.oeuvre.titre} — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">{data.oeuvre.titre}</h1>
	<p class="mt-1 text-sm text-neutral-500">
		{data.oeuvre.type}
		{#if data.oeuvre.serie}· {data.oeuvre.serie}{/if}
		{#if data.oeuvre.numeroDansLaSerie !== null}· n° {data.oeuvre.numeroDansLaSerie}{/if}
		{#if data.oeuvre.dateDeParution}· {data.oeuvre.dateDeParution}{/if}
	</p>

	<!-- R28 — l’agrégat ne passe jamais par le masquage. -->
	<p class="mt-4 text-sm">
		{#if data.agregat.noteMoyenne !== null}
			<span class="font-medium">{etoiles(data.agregat.noteMoyenne)}</span>
			<span class="text-neutral-500">
				{data.agregat.noteMoyenne.toFixed(1)} · {data.agregat.nombreDeNotes} note{data.agregat
					.nombreDeNotes > 1
					? 's'
					: ''}
			</span>
		{:else}
			<span class="text-neutral-500">Personne du groupe ne l’a encore notée.</span>
		{/if}
		<span class="text-neutral-500">
			· {data.agregat.nombreDAvis} avis
		</span>
	</p>

	{#if arrives.length > 0 || enRoute.length > 0}
		<h2 class="mt-10 text-sm font-semibold tracking-tight">Le groupe</h2>
		<ul class="mt-2 text-sm text-neutral-700">
			{#if arrives.length > 0}
				<li>
					<span class="text-neutral-500">L’ont atteinte :</span>
					{arrives.map((lecteur) => (lecteur.parti ? 'un membre parti' : lecteur.nom)).join(', ')}
				</li>
			{/if}
			{#each enRoute as lecteur (lecteur.membreId)}
				<li>
					<span class="text-neutral-500">En cours :</span>
					{lecteur.parti ? 'un membre parti' : lecteur.nom}
					{#if lecteur.position > 0}· {pourcentage(lecteur.position)}{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-sm font-semibold tracking-tight">Avis</h2>

	{#if data.avis.length === 0}
		<p class="mt-2 text-sm text-neutral-500">Personne n’a encore écrit.</p>
	{:else}
		<div class="mt-2 divide-y divide-neutral-200">
			{#each data.avis as avis (avis.id)}
				<MaskedText
					oeuvreId={avis.oeuvreId}
					auteur={avis.auteur.nom}
					note={avis.note}
					ecritLe={avis.ecritLe}
					masque={avis.masque}
					texte={avis.texte}
				/>
			{/each}
		</div>
	{/if}
</main>
