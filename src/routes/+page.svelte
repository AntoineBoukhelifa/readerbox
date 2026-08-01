<script lang="ts">
	import { resolve } from '$app/paths';
	import Affiche from '$lib/components/Affiche.svelte';
	import Grille from '$lib/components/Grille.svelte';
	import Jauge from '$lib/components/Jauge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const rienDeConsigne = $derived(data.enCours.length === 0 && data.derniereLecture.length === 0);
</script>

<svelte:head><title>readerbox</title></svelte:head>

{#if data.member}
	<main class="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
		<h1 class="font-display text-2xl leading-none tracking-tight">
			Salut {data.member.displayName}
		</h1>

		{#if rienDeConsigne}
			<p class="mt-3 max-w-xl text-sm leading-relaxed text-encre-basse">
				Ton étagère est vide. Cherche ce que tu viens de lire et pose-le dessus — c’est en
				<strong class="font-normal text-encre">atteignant</strong> des œuvres, pas seulement en les consignant,
				que les avis du groupe s’ouvrent et que ton graphe apparaît.
			</p>
			<p class="mt-6 flex flex-wrap gap-3">
				<a href={resolve('/search')} class="action">Chercher une œuvre</a>
				<a href={resolve('/orders')} class="action-sourde">Voir les ordres du groupe</a>
			</p>
		{:else}
			<p class="mt-2 text-sm text-encre-basse">
				Le liseré d’or marque ce que tu as atteint — terminé ou abandonné. Le reste t’attend.
			</p>
		{/if}

		{#if data.enCours.length > 0}
			<h2 class="mt-12 enseigne">En cours</h2>
			<div class="mt-4">
				<Grille>
					{#each data.enCours as oeuvre, rang (oeuvre.id)}
						<li>
							<Affiche
								titre={oeuvre.titre}
								couvertureUrl={oeuvre.couvertureUrl}
								href={resolve('/work/[id]', { id: oeuvre.id })}
								etat="consigne"
								position={oeuvre.position}
								note={oeuvre.note}
								{rang}
							/>
						</li>
					{/each}
				</Grille>
			</div>
		{/if}

		{#if data.derniereLecture.length > 0}
			<h2 class="mt-12 enseigne">Dernières atteintes</h2>
			<div class="mt-4">
				<Grille serree>
					{#each data.derniereLecture as oeuvre, rang (oeuvre.id)}
						<li>
							<Affiche
								titre={oeuvre.titre}
								couvertureUrl={oeuvre.couvertureUrl}
								href={resolve('/work/[id]', { id: oeuvre.id })}
								etat="atteint"
								note={oeuvre.note}
								{rang}
							/>
						</li>
					{/each}
				</Grille>
			</div>
		{/if}

		{#if data.ordres.length > 0}
			<div class="mt-12 flex items-baseline justify-between gap-4">
				<h2 class="enseigne">Les ordres du groupe</h2>
				<a href={resolve('/orders')} class="lien text-xs text-encre-basse">Tous les ordres</a>
			</div>

			<ul class="mt-4 border-t border-trait">
				{#each data.ordres as ordre (ordre.id)}
					<li
						class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-trait py-3"
					>
						<span class="min-w-0">
							<a
								href={resolve('/order/[id]', { id: ordre.id })}
								class="lien font-display text-lg leading-tight">{ordre.titre}</a
							>
							<span class="ml-2 text-xs text-encre-tenue">
								par {ordre.auteur} · {ordre.nombreDEntrees} entrée{ordre.nombreDEntrees > 1
									? 's'
									: ''}{#if ordre.suivi}
									· tu le suis{/if}
							</span>
						</span>
						<span class="w-40 shrink-0"><Jauge pourcentage={ordre.pourcentage} /></span>
					</li>
				{/each}
			</ul>
		{/if}
	</main>
{:else}
	<!--
		Déconnecté, l'accueil n'a rien à montrer et ne fait pas semblant : le
		groupe est fermé, on n'y entre que par un lien.
	-->
	<main class="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-5 py-20">
		<h1 class="font-display text-5xl leading-none tracking-[0.14em] uppercase">readerbox</h1>
		<p class="mt-6 text-base leading-relaxed text-encre-basse">
			Un compagnon de l’univers Marvel, pour un groupe fermé. Ce qu’on lit, ce qu’on regarde, dans
			quel ordre, et ce qu’on en a pensé — sans se gâcher la suite.
		</p>
		<p class="mt-8 border-l-2 border-trait pl-4 text-sm leading-relaxed text-encre-tenue">
			On n’entre que sur invitation. Demande son lien à quelqu’un qui est déjà là.
		</p>
	</main>
{/if}
