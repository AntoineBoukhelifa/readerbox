<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
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

	const LIBELLES_ETAGERE = [
		{ valeur: 'a_decouvrir', libelle: 'À découvrir' },
		{ valeur: 'en_cours', libelle: 'En cours' }
	] as const;
</script>

<svelte:head><title>Ton graphe — readerbox</title></svelte:head>

<main class="mx-auto max-w-4xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">Ton graphe</h1>
	<p class="mt-2 text-sm text-neutral-500">
		Ce que tes lectures ont fait apparaître. Un nœud est un personnage, une série ou un event ; deux
		nœuds se touchent quand une œuvre que tu as atteinte les crédite tous les deux.
	</p>

	{#if data.volume.noeuds === 0}
		<!-- ------------------------------------------------------------------ -->
		<!-- L'état d'accueil : l'écran qu'un nouveau membre verra le plus       -->
		<!-- longtemps, et celui où le produit doit se faire comprendre.         -->
		<!-- ------------------------------------------------------------------ -->
		<section class="mt-10 rounded-md border border-neutral-300 bg-neutral-50 p-6">
			<h2 class="text-sm font-semibold tracking-tight">Il est vide, et c’est normal</h2>
			<p class="mt-2 text-sm text-neutral-700">
				Le graphe se construit à mesure de tes lectures : chaque œuvre que tu <strong
					>atteins</strong
				>
				— terminée ou abandonnée — y fait apparaître ses personnages, sa série et son event. Ce que tu
				n’as pas atteint reste invisible, ici comme partout ailleurs : c’est ce qui fait qu’on peut te
				le montrer sans rien te gâcher.
			</p>
			<p class="mt-3 text-sm text-neutral-700">
				{#if data.suggestion}
					Pour l’amorcer, suis un ordre du groupe —
					<a
						href={resolve('/order/[id]', { id: data.suggestion.id })}
						class="font-medium underline underline-offset-4">{data.suggestion.titre}</a
					>
					est le dernier qui a bougé — et consigne ce que tu lis au fur et à mesure.
				{:else}
					Personne n’a encore écrit d’ordre. Commence par consigner ce que tu as déjà lu : deux ou
					trois œuvres suffisent à faire apparaître un premier lien.
				{/if}
			</p>
			<p class="mt-4">
				<a
					href={resolve('/orders')}
					class="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
				>
					Les ordres du groupe
				</a>
			</p>
		</section>
	{:else}
		<!-- ------------------------------------------------------------------ -->
		<!-- R49 — le filtrage par dimension, plafonné à deux.                   -->
		<!-- ------------------------------------------------------------------ -->
		<section class="mt-8">
			<div class="flex flex-wrap items-center gap-4">
				{#each DIMENSIONS as dimension (dimension)}
					<label
						class="flex items-center gap-2 text-sm {verrouillee(dimension)
							? 'text-neutral-400'
							: 'text-neutral-700'}"
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
				<span class="text-xs text-neutral-400">
					Deux dimensions au plus : au-delà, plus rien ne se lit.
				</span>
			</div>

			{#if data.message}
				<p class="mt-3 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm">
					{data.message}
				</p>
			{/if}

			{#if !data.filtrageClient}
				<p class="mt-3 text-xs text-neutral-400">
					Ton graphe dépasse ce qu’on envoie d’un bloc : le filtrage se fait sur le serveur, donc
					changer de dimension recharge la page.
				</p>
			{/if}

			{#if affiche.tronque}
				<p class="mt-3 text-xs text-neutral-400">
					Une œuvre que tu as atteinte crédite trop de monde pour que ses liens soient tous dessinés
					: ses nœuds sont là, ses traits manquent.
				</p>
			{/if}
		</section>

		<section class="mt-4">
			{#if affiche.noeuds.length === 0}
				<!--
					Ton graphe n'est pas vide, mais rien n'y répond aux cases cochées : le
					dire, plutôt que de rendre le même écran qu'un graphe vide, qui ferait
					croire que rien n'a été lu.
				-->
				<p class="rounded-md border border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-700">
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
		<p class="mt-6 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700">
			{form.message}
		</p>
	{/if}

	<!-- -------------------------------------------------------------------- -->
	<!-- R53 — l'ouverture d'un nœud, en trois volets.                         -->
	<!-- -------------------------------------------------------------------- -->
	{#if data.noeud}
		{@const noeud = data.noeud}
		<section class="mt-10 rounded-md border border-neutral-300 p-6">
			<div class="flex items-baseline justify-between gap-4">
				<h2 class="text-lg font-semibold tracking-tight">{noeud.nom}</h2>
				<a
					href={resolve(`/graph?${requete(actives, null)}`)}
					class="text-sm text-neutral-500 underline underline-offset-4">Fermer</a
				>
			</div>
			<p class="mt-1 text-sm text-neutral-500">
				{LIBELLES_DIMENSION[noeud.dimension]} · {noeud.oeuvres.length} œuvre{noeud.oeuvres.length >
				1
					? 's'
					: ''} atteinte{noeud.oeuvres.length > 1 ? 's' : ''}
			</p>

			<h3 class="mt-6 text-sm font-semibold tracking-tight">Ce qui l’a fait apparaître</h3>
			<ul class="mt-2 divide-y divide-neutral-200">
				{#each noeud.oeuvres as oeuvre (oeuvre.id)}
					<li class="py-2 text-sm">
						<a href={resolve('/work/[id]', { id: oeuvre.id })} class="underline underline-offset-4"
							>{oeuvre.titre}</a
						>
						<span class="text-neutral-500">
							· {oeuvre.type}{#if oeuvre.dateDeParution}
								· {oeuvre.dateDeParution}{/if}
						</span>
					</li>
				{/each}
			</ul>

			<h3 class="mt-6 text-sm font-semibold tracking-tight">Les ordres qui les couvrent</h3>
			{#if noeud.ordres.length === 0}
				<p class="mt-2 text-sm text-neutral-500">
					Aucun ordre du groupe ne passe par ces œuvres. C’est peut-être à toi d’en écrire un.
				</p>
			{:else}
				<ul class="mt-2 divide-y divide-neutral-200">
					{#each noeud.ordres as ordre (ordre.id)}
						<li class="py-2 text-sm">
							<a
								href={resolve('/order/[id]', { id: ordre.id })}
								class="underline underline-offset-4">{ordre.titre}</a
							>
							<span class="text-neutral-500">
								· par {ordre.auteur ?? 'un membre parti'} · {ordre.couvertes} de ces œuvres sur {ordre.nombreDEntrees}
								entrées
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			<!-- Le volet sans lequel le graphe ne serait qu'un rétroviseur. -->
			<h3 class="mt-6 text-sm font-semibold tracking-tight">Ce que tu n’as pas encore atteint</h3>
			{#if noeud.apparitions.length === 0}
				<p class="mt-2 text-sm text-neutral-500">
					Le catalogue ne connaît rien d’autre à ce nom. Il ne contient que ce qui a déjà été ingéré
					: d’autres apparitions existent sûrement et n’y sont pas encore.
				</p>
			{:else}
				<ul class="mt-2 divide-y divide-neutral-200">
					{#each noeud.apparitions as apparition (apparition.id)}
						<li class="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
							<span>
								<a
									href={resolve('/work/[id]', { id: apparition.id })}
									class="underline underline-offset-4">{apparition.titre}</a
								>
								<span class="text-neutral-500">
									· {apparition.type}{#if apparition.dateDeParution}
										· {apparition.dateDeParution}{/if}
								</span>
							</span>

							{#if apparition.consignee}
								<span class="text-xs text-neutral-400">déjà sur une étagère</span>
							{:else}
								<form method="POST" action={actionConsigner} class="flex items-center gap-2">
									<input type="hidden" name="oeuvre" value={apparition.id} />
									{#each LIBELLES_ETAGERE as etagere (etagere.valeur)}
										<button
											name="etagere"
											value={etagere.valeur}
											class="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
										>
											{etagere.libelle}
										</button>
									{/each}
								</form>
							{/if}
						</li>
					{/each}
				</ul>
				{#if noeud.apparitionsTronquees}
					<p class="mt-2 text-xs text-neutral-400">
						D’autres apparitions existent au catalogue ; seules les plus anciennes sont proposées
						ici.
					</p>
				{/if}
			{/if}
		</section>
	{/if}
</main>
