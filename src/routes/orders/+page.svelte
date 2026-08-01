<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const avancement = (pourcentage: number | null) =>
		pourcentage === null ? '—' : `${pourcentage} %`;
</script>

<svelte:head><title>Les ordres — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<div class="mt-6 flex items-baseline justify-between gap-4">
		<h1 class="text-2xl font-semibold tracking-tight">Les ordres</h1>
		<a href={resolve('/order/new')} class="text-sm font-medium underline underline-offset-4">
			En écrire un
		</a>
	</div>

	<p class="mt-2 text-sm text-neutral-500">
		Par où entrer, et quoi lire ensuite. Le pourcentage est le tien : il compte les entrées
		essentielles que tu as déjà atteintes, que tu suives l’ordre ou non.
	</p>

	{#if data.ordres.length === 0}
		<p class="mt-8 text-sm text-neutral-500">
			Personne n’en a encore écrit. C’est un geste coûteux qu’une seule personne fait pour tout le
			groupe — et c’est la chose la plus utile que tu puisses faire ici.
		</p>
	{:else}
		<ul class="mt-8 divide-y divide-neutral-200">
			{#each data.ordres as ordre (ordre.id)}
				<li class="py-4">
					<div class="flex items-baseline justify-between gap-4">
						<a
							href={resolve('/order/[id]', { id: ordre.id })}
							class="text-sm font-medium underline underline-offset-4">{ordre.titre}</a
						>
						<span class="text-sm whitespace-nowrap text-neutral-500">
							{avancement(ordre.pourcentage)}
						</span>
					</div>

					<p class="mt-1 text-sm text-neutral-500">
						par {ordre.auteur} · {ordre.nombreDEntrees} entrée{ordre.nombreDEntrees > 1 ? 's' : ''}
						· {ordre.nombreDeSuiveurs} suiveur{ordre.nombreDeSuiveurs > 1 ? 's' : ''}
						{#if ordre.suivi}· tu le suis{/if}
						{#if ordre.mien}· le tien{/if}
					</p>

					{#if ordre.description}
						<p class="mt-1 line-clamp-2 text-sm text-neutral-700">{ordre.description}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
