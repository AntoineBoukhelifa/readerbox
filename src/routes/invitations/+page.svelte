<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Partager — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
	<h1 class="font-display text-2xl leading-none tracking-tight">Faire entrer quelqu’un</h1>
	<p class="mt-3 text-sm leading-relaxed text-encre-basse">
		Il n’y a plus de lien à générer. L’adresse <em>est</em> la clé : envoie-la, la personne met son nom
		et elle est là.
	</p>

	<div class="mt-6 border-l-2 border-or bg-cimaise px-4 py-3">
		<code class="block text-sm break-all text-or">{data.adresse}</code>
	</div>

	<p class="mt-6 border-l-2 border-trait pl-4 text-sm leading-relaxed text-encre-tenue">
		Ce qui suit du choix : qui a l’adresse peut reprendre n’importe quel nom de la liste. C’est
		voulu — c’est ce qui permet de retrouver son journal sur un autre appareil sans rien avoir
		gardé. Garde donc l’adresse entre vous.
	</p>

	<h2 class="mt-14 enseigne">Toi, ailleurs</h2>
	<p class="mt-3 text-sm leading-relaxed text-encre-basse">
		Sur un autre téléphone ou après avoir vidé tes cookies : ouvre l’adresse et remets le même nom.
		Tu retombes sur ton journal, pas sur un compte vide.
	</p>

	<h2 class="mt-14 enseigne">Qui est là</h2>
	{#if data.presents.length === 0}
		<p class="mt-3 text-sm text-encre-tenue">Personne d’autre pour l’instant.</p>
	{:else}
		<ul class="mt-3 flex flex-wrap gap-2">
			{#each data.presents as membre (membre.id)}
				<li class="border border-trait px-3 py-1.5 text-sm text-encre-basse">{membre.nom}</li>
			{/each}
		</ul>
	{/if}
</main>
