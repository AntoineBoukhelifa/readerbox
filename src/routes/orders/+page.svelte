<script lang="ts">
	import { resolve } from '$app/paths';
	import Jauge from '$lib/components/Jauge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Les ordres — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-4xl flex-1 px-5 py-10">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="font-display text-2xl leading-none tracking-tight">Les ordres</h1>
			<p class="mt-2 max-w-2xl text-sm leading-relaxed text-encre-basse">
				Par où entrer, et quoi lire ensuite. Le pourcentage est le tien : il compte les entrées
				essentielles que tu as déjà <strong class="font-normal text-or">atteintes</strong>, que tu
				suives l’ordre ou non.
			</p>
		</div>
		<a href={resolve('/order/new')} class="action">En écrire un</a>
	</div>

	{#if data.ordres.length === 0}
		<p class="mt-12 max-w-xl text-sm leading-relaxed text-encre-tenue">
			Personne n’en a encore écrit. C’est un geste coûteux qu’une seule personne fait pour tout le
			groupe — et c’est la chose la plus utile que tu puisses faire ici.
		</p>
	{:else}
		<ul class="mt-10 border-t border-trait">
			{#each data.ordres as ordre (ordre.id)}
				<li class="border-b border-trait py-5">
					<div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
						<h2 class="min-w-0 text-xl leading-tight">
							<a href={resolve('/order/[id]', { id: ordre.id })} class="lien">{ordre.titre}</a>
						</h2>
						<span class="w-44 shrink-0"><Jauge pourcentage={ordre.pourcentage} /></span>
					</div>

					<p class="mt-1 text-xs text-encre-tenue">
						par {ordre.auteur} · {ordre.nombreDEntrees} entrée{ordre.nombreDEntrees > 1 ? 's' : ''}
						· {ordre.nombreDeSuiveurs} suiveur{ordre.nombreDeSuiveurs > 1 ? 's' : ''}
						{#if ordre.suivi}· tu le suis{/if}
						{#if ordre.mien}· le tien{/if}
					</p>

					{#if ordre.description}
						<p class="mt-2 line-clamp-2 max-w-2xl text-sm leading-relaxed text-encre-basse">
							{ordre.description}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
