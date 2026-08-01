<script lang="ts">
	import AfficheDeCatalogue from '$lib/components/AfficheDeCatalogue.svelte';
	import Grille from '$lib/components/Grille.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const situation = (resultat: (typeof data.resultats)[number]) =>
		[
			resultat.serie,
			resultat.numeroDansLaSerie === null ? null : `n° ${resultat.numeroDansLaSerie}`,
			resultat.dateDeParution
		]
			.filter((morceau): morceau is string => Boolean(morceau))
			.join(' · ');

	const titre = $derived(data.nom ?? `${data.libelle} ${data.idExterne}`);
</script>

<svelte:head><title>{titre} — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
	<p class="enseigne">{data.libelle} · {data.source}</p>
	<h1 class="mt-1 font-display text-3xl leading-none tracking-tight">{titre}</h1>
	<p class="mt-2 max-w-2xl text-sm leading-relaxed text-encre-basse">
		Ce que la source connaît, pas seulement ce que le groupe a consigné. Le liseré d’or marque ce
		que tu as déjà atteint.
	</p>

	{#if form?.message}
		<p class="mt-4 border-l-2 border-trait bg-cimaise px-4 py-3 text-sm text-encre-basse">
			{form.message}
		</p>
	{/if}

	{#each data.degradations as degradation (degradation.source)}
		<p class="mt-4 border-l-2 border-or-sourd bg-cimaise px-4 py-3 text-sm text-encre-basse">
			{degradation.message}
		</p>
	{/each}

	{#if !data.axeCouvert}
		<p class="mt-10 max-w-xl text-sm leading-relaxed text-encre-tenue">
			Cette source ne sait pas parcourir cet axe. Ce n’est pas une panne : elle n’expose pas cette
			donnée.
		</p>
	{:else if data.resultats.length === 0}
		<p class="mt-10 text-sm text-encre-tenue">Aucune œuvre rattachée.</p>
	{:else}
		<div class="mt-10">
			<Grille>
				{#each data.resultats as resultat, rang (resultat.cle)}
					<li>
						<AfficheDeCatalogue
							titre={resultat.titre}
							couvertureUrl={resultat.couvertureUrl}
							oeuvreId={resultat.oeuvreId}
							source={resultat.source}
							idExterne={resultat.idExterne}
							situation={situation(resultat)}
							mien={resultat.mien}
							consignee={resultat.consignee}
							connueDuGroupe={resultat.connueDuGroupe}
							{rang}
						/>
					</li>
				{/each}
			</Grille>
		</div>
	{/if}
</main>
