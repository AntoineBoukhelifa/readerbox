<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Affiche from '$lib/components/Affiche.svelte';
	import Grille from '$lib/components/Grille.svelte';
	import Graph from '$lib/components/Graph.svelte';
	import {
		DIMENSIONS,
		LIBELLES_DIMENSION,
		MAX_DIMENSIONS_ACTIVES,
		filtrer,
		type Dimension
	} from '$lib/graph/rendu';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * Les dimensions actives, et les deux chemins pour en changer.
	 *
	 * Sous le seuil, le serveur a envoyé le graphe entier : cocher une case ne
	 * coûte rien, l'état vit ici et la page ne recharge pas. Au-dessus, la charge
	 * utile ne porte que les dimensions demandées et il faut repasser par le
	 * serveur. **Les deux chemins appliquent le même filtre** — `filtrer`, plus
	 * bas, sur un graphe déjà restreint ou non, ce qui ne change rien puisqu'il
	 * est idempotent. Un filtre écrit deux fois finirait par montrer deux choses.
	 */
	let choisies = $state<Dimension[] | null>(null);
	const actives = $derived(choisies ?? data.dimensions);

	// Une navigation — ouvrir un nœud, revenir en arrière — refait autorité : les
	// dimensions de l'URL redeviennent celles qui s'appliquent, et le choix local
	// s'efface.
	$effect(() => {
		void data.dimensions;
		choisies = null;
	});

	const affiche = $derived(filtrer(data.graphe, actives));

	const noeudOuvert = $derived(data.noeud?.id ?? null);

	/**
	 * La requête du graphe : les dimensions actives, et le nœud ouvert s'il y en a
	 * un. C'est elle qui rend l'état de la page partageable et navigable en
	 * arrière — ouvrir un nœud sans elle ferait retomber le filtre au défaut.
	 *
	 * Les valeurs sont assemblées à la main plutôt que par `URLSearchParams` : les
	 * dimensions viennent d'une énumération fermée et l'identifiant d'entité est
	 * un UUID, donc rien n'a besoin d'être échappé, et une instance mutable de
	 * `URLSearchParams` dans un composant n'aurait pas la réactivité qu'on croit.
	 */
	function requete(dimensions: readonly Dimension[], noeud: string | null): string {
		const parties = dimensions.map((dimension) => `dimension=${dimension}`);
		if (noeud !== null) parties.push(`noeud=${encodeURIComponent(noeud)}`);
		return parties.join('&');
	}

	const lienDuNoeud = (entiteId: string) => resolve(`/graph?${requete(actives, entiteId)}`);

	/** Le formulaire de consignation garde le nœud ouvert et les dimensions. */
	const actionConsigner = $derived(`?${requete(actives, noeudOuvert)}&/consigner`);

	const dimensionsCochees = $derived(
		actives.map((dimension) => LIBELLES_DIMENSION[dimension].toLowerCase()).join(' et ')
	);

	/** R49 — au plus deux dimensions à la fois, et jamais zéro. */
	function verrouillee(dimension: Dimension): boolean {
		const cochee = actives.includes(dimension);
		return cochee ? actives.length === 1 : actives.length >= MAX_DIMENSIONS_ACTIVES;
	}

	function basculer(dimension: Dimension): void {
		if (verrouillee(dimension)) return;

		const voulues = actives.includes(dimension)
			? actives.filter((autre) => autre !== dimension)
			: DIMENSIONS.filter((autre) => autre === dimension || actives.includes(autre));

		if (data.filtrageClient) choisies = [...voulues];
		else void goto(resolve(`/graph?${requete(voulues, noeudOuvert)}`));
	}

	/** Les deux étagères qu'on pose sans quitter le graphe. L'abandon est ailleurs (R2). */
	const LIBELLES_ETAGERE = [
		{ valeur: 'a_decouvrir', libelle: 'À découvrir' },
		{ valeur: 'en_cours', libelle: 'En cours' }
	] as const;
</script>

<svelte:head><title>Ton graphe — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
	<h1 class="font-display text-2xl leading-none tracking-tight">Ton graphe</h1>
	<p class="mt-2 max-w-2xl text-sm leading-relaxed text-encre-basse">
		Ce que tes lectures ont fait apparaître. Un nœud est un personnage, une série ou un event ; deux
		nœuds se touchent quand une œuvre que tu as <strong class="font-normal text-or">atteinte</strong
		>
		les crédite tous les deux.
	</p>

	{#if data.volume.noeuds === 0}
		<!-- ------------------------------------------------------------------ -->
		<!-- L'état d'accueil : l'écran qu'un nouveau membre verra le plus       -->
		<!-- longtemps, et celui où le produit doit se faire comprendre.         -->
		<!-- ------------------------------------------------------------------ -->
		<section class="mt-10 max-w-2xl border-l-2 border-or-sourd py-2 pl-5">
			<h2 class="font-display text-xl leading-none tracking-wide uppercase">
				Il est vide, et c’est normal
			</h2>
			<p class="mt-3 text-sm leading-relaxed text-encre-basse">
				Le graphe se construit à mesure de tes lectures : chaque œuvre que tu
				<strong class="font-normal text-or">atteins</strong>
				— terminée ou abandonnée — y fait apparaître ses personnages, sa série et son event. Ce que tu
				n’as pas atteint reste invisible, ici comme partout ailleurs : c’est ce qui fait qu’on peut te
				le montrer sans rien te gâcher.
			</p>
			<p class="mt-3 text-sm leading-relaxed text-encre-basse">
				{#if data.suggestion}
					Pour l’amorcer, suis un ordre du groupe —
					<a href={resolve('/order/[id]', { id: data.suggestion.id })} class="lien"
						>{data.suggestion.titre}</a
					>
					est le dernier qui a bougé — et consigne ce que tu lis au fur et à mesure.
				{:else}
					Personne n’a encore écrit d’ordre. Commence par consigner ce que tu as déjà lu : deux ou
					trois œuvres suffisent à faire apparaître un premier lien.
				{/if}
			</p>
			<p class="mt-5">
				<a href={resolve('/orders')} class="action">Les ordres du groupe</a>
			</p>
		</section>
	{:else}
		<!-- ------------------------------------------------------------------ -->
		<!-- R49 — le filtrage par dimension, plafonné à deux.                   -->
		<!-- ------------------------------------------------------------------ -->
		<section class="mt-8">
			<div class="flex flex-wrap items-center gap-5">
				{#each DIMENSIONS as dimension (dimension)}
					<label
						class="flex items-center gap-2 text-sm {verrouillee(dimension)
							? 'text-encre-tenue'
							: 'text-encre'}"
					>
						<input
							type="checkbox"
							checked={actives.includes(dimension)}
							disabled={verrouillee(dimension)}
							onchange={() => basculer(dimension)}
						/>
						{LIBELLES_DIMENSION[dimension]}
					</label>
				{/each}
				<span class="text-xs text-encre-tenue">
					Deux dimensions au plus : au-delà, plus rien ne se lit.
				</span>
			</div>

			{#if data.message}
				<p class="mt-4 border-l-2 border-or-sourd bg-cimaise px-4 py-3 text-sm text-encre-basse">
					{data.message}
				</p>
			{/if}

			{#if !data.filtrageClient}
				<p class="mt-3 text-xs text-encre-tenue">
					Ton graphe dépasse ce qu’on envoie d’un bloc : le filtrage se fait sur le serveur, donc
					changer de dimension recharge la page.
				</p>
			{/if}

			{#if affiche.tronque}
				<p class="mt-3 text-xs text-encre-tenue">
					Une œuvre que tu as atteinte crédite trop de monde pour que ses liens soient tous dessinés
					: ses nœuds sont là, ses traits manquent.
				</p>
			{/if}
		</section>

		<section class="mt-5">
			{#if affiche.noeuds.length === 0}
				<!--
					Ton graphe n'est pas vide, mais rien n'y répond aux cases cochées : le
					dire, plutôt que de rendre le même écran qu'un graphe vide, qui ferait
					croire que rien n'a été lu.
				-->
				<p class="border-l-2 border-trait bg-cimaise px-4 py-4 text-sm text-encre-basse">
					Tes lectures n’ont encore rien fait apparaître de ce côté-là ({dimensionsCochees}). Essaie
					une autre case : ton graphe compte {data.volume.noeuds} nœud{data.volume.noeuds > 1
						? 's'
						: ''} en tout.
				</p>
			{:else}
				<Graph graphe={affiche} selection={noeudOuvert} onouvrir={(id) => goto(lienDuNoeud(id))} />
			{/if}
		</section>
	{/if}

	{#if form?.message}
		<p class="mt-6 border-l-2 border-trait bg-cimaise px-4 py-3 text-sm text-encre-basse">
			{form.message}
		</p>
	{/if}

	<!-- -------------------------------------------------------------------- -->
	<!-- R53 — l'ouverture d'un nœud, en trois volets.                         -->
	<!-- -------------------------------------------------------------------- -->
	{#if data.noeud}
		{@const noeud = data.noeud}
		<section class="mt-10 border-t border-trait pt-6">
			<div class="flex flex-wrap items-baseline justify-between gap-4">
				<div>
					<p class="enseigne">{LIBELLES_DIMENSION[noeud.dimension]}</p>
					<h2 class="mt-1 font-display text-3xl leading-none tracking-tight">{noeud.nom}</h2>
					<p class="mt-1 text-sm text-or">
						{noeud.oeuvres.length} œuvre{noeud.oeuvres.length > 1 ? 's' : ''} atteinte{noeud.oeuvres
							.length > 1
							? 's'
							: ''}
					</p>
				</div>
				<a href={resolve(`/graph?${requete(actives, null)}`)} class="lien text-sm text-encre-tenue"
					>Fermer</a
				>
			</div>

			<h3 class="mt-8 enseigne">Ce qui l’a fait apparaître</h3>
			<div class="mt-4">
				<Grille serree>
					{#each noeud.oeuvres as oeuvre, rang (oeuvre.id)}
						<li>
							<Affiche
								titre={oeuvre.titre}
								couvertureUrl={oeuvre.couvertureUrl}
								href={resolve('/work/[id]', { id: oeuvre.id })}
								situation={[oeuvre.type, oeuvre.dateDeParution].filter(Boolean).join(' · ')}
								etat="atteint"
								{rang}
							/>
						</li>
					{/each}
				</Grille>
			</div>

			<h3 class="mt-10 enseigne">Les ordres qui les couvrent</h3>
			{#if noeud.ordres.length === 0}
				<p class="mt-3 max-w-xl text-sm leading-relaxed text-encre-tenue">
					Aucun ordre du groupe ne passe par ces œuvres. C’est peut-être à toi d’en écrire un.
				</p>
			{:else}
				<ul class="mt-3 max-w-2xl border-t border-trait">
					{#each noeud.ordres as ordre (ordre.id)}
						<li class="border-b border-trait py-2 text-sm">
							<a href={resolve('/order/[id]', { id: ordre.id })} class="lien">{ordre.titre}</a>
							<span class="block text-xs text-encre-tenue">
								par {ordre.auteur ?? 'un membre parti'} · {ordre.couvertes} de ces œuvres sur {ordre.nombreDEntrees}
								entrées
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			<!-- Le volet sans lequel le graphe ne serait qu'un rétroviseur. -->
			<h3 class="mt-10 enseigne">Ce que tu n’as pas encore atteint</h3>
			{#if noeud.apparitions.length === 0}
				<p class="mt-3 max-w-xl text-sm leading-relaxed text-encre-tenue">
					Le catalogue ne connaît rien d’autre à ce nom. Il ne contient que ce qui a déjà été ingéré
					: d’autres apparitions existent sûrement et n’y sont pas encore.
				</p>
			{:else}
				<div class="mt-4">
					<Grille>
						{#each noeud.apparitions as apparition, rang (apparition.id)}
							<li>
								<Affiche
									titre={apparition.titre}
									couvertureUrl={apparition.couvertureUrl}
									href={resolve('/work/[id]', { id: apparition.id })}
									situation={[apparition.type, apparition.dateDeParution]
										.filter(Boolean)
										.join(' · ')}
									etat={apparition.consignee ? 'consigne' : 'aucun'}
									{rang}
								>
									{#if apparition.consignee}
										<p class="mt-1 text-[0.7rem] text-encre-tenue">Déjà sur une étagère</p>
									{:else}
										<form method="POST" action={actionConsigner} class="mt-2 flex flex-wrap gap-1">
											<input type="hidden" name="oeuvre" value={apparition.id} />
											{#each LIBELLES_ETAGERE as etagere (etagere.valeur)}
												<button
													name="etagere"
													value={etagere.valeur}
													class="action-sourde px-1.5 py-0.5 text-[0.7rem]"
												>
													{etagere.libelle}
												</button>
											{/each}
										</form>
									{/if}
								</Affiche>
							</li>
						{/each}
					</Grille>
				</div>
				{#if noeud.apparitionsTronquees}
					<p class="mt-3 text-xs text-encre-tenue">
						D’autres apparitions existent au catalogue ; seules les plus anciennes sont proposées
						ici.
					</p>
				{/if}
			{/if}
		</section>
	{/if}
</main>
