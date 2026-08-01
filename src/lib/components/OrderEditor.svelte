<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	/**
	 * L'éditeur d'ordre — le geste dont le document d'origine dit qu'il porte
	 * toute la promesse du produit.
	 *
	 * Trois décisions le structurent, et toutes viennent de la même contrainte :
	 * **F2 parle d'ordres allant jusqu'à trois cents entrées.**
	 *
	 * 1. **Le versement se fait par recherche incrémentale et par série entière.**
	 *    Verser trois cents numéros un par un depuis une liste déroulante serait
	 *    une punition ; « ajouter toute la série X » est le geste réel de quiconque
	 *    écrit un ordre de lecture.
	 * 2. **Le réordonnancement a un repli clavier.** Le glisser-déposer seul est
	 *    inaccessible et impraticable au-delà d'une vingtaine de lignes — faire
	 *    descendre une entrée de la position 3 à la position 250 en la traînant sur
	 *    un écran qui défile est un supplice. Chaque ligne porte donc aussi deux
	 *    boutons de déplacement et un champ de rang, qui fonctionnent sans script.
	 * 3. **Aucune dépendance de glisser-déposer.** Les événements HTML natifs
	 *    suffisent, et le dépôt se contente de soumettre le même formulaire que le
	 *    champ de rang : une seule route, un seul comportement à tenir juste.
	 *
	 * Tout passe par des formulaires POST classiques. Le script n'ajoute que deux
	 * agréments — la frappe qui relance la recherche, et le glisser-déposer — et
	 * la page reste entièrement utilisable sans lui.
	 */

	interface EntreeAffichee {
		id: string;
		rang: number;
		facultative: boolean;
		introuvable: boolean;
		atteinte: boolean;
		oeuvre: { id: string; titre: string; type: string } | null;
	}

	/**
	 * Un résultat de versement. `id` est nul tant que l'œuvre n'est pas entrée au
	 * catalogue : elle vient d'une source amont, et c'est le versement qui
	 * l'ingérera (KTD1). La clé d'itération tombe alors sur la référence.
	 */
	interface ResultatAffiche {
		id: string | null;
		reference: { source: string; idExterne: string } | null;
		titre: string;
		type: string;
		serie: string | null;
		numeroDansLaSerie: number | null;
		dateDeParution: string | null;
		couvertureUrl: string | null;
		dejaPresente: boolean;
		connueDuGroupe: boolean;
	}

	interface Props {
		entrees: EntreeAffichee[];
		requete: string;
		resultats: ResultatAffiche[];
		degradations?: { source: string; message: string }[];
		series: { entityId: string; nom: string; nombreDOeuvres: number }[];
	}

	let { entrees, requete, resultats, degradations = [], series }: Props = $props();

	const cle = (resultat: ResultatAffiche) =>
		resultat.id ?? `${resultat.reference?.source}:${resultat.reference?.idExterne}`;

	// -----------------------------------------------------------------------
	// Recherche incrémentale
	// -----------------------------------------------------------------------

	// La saisie part de la requête de l'URL, puis vit sa vie : la relier au
	// serveur remettrait le curseur au début à chaque réponse.
	let saisie = $state(untrack(() => requete));
	let minuteur: ReturnType<typeof setTimeout> | undefined;

	/**
	 * La frappe relance la recherche, mais pas à chaque caractère : deux cent
	 * cinquante millisecondes de silence, sans quoi vingt membres derrière une
	 * seule base feraient une requête par lettre.
	 *
	 * La navigation se fait vers la page courante, seule la requête change. La
	 * règle `no-navigation-without-resolve` existe pour attraper les chemins
	 * écrits à la main ; ici la destination *est* l'URL courante, déjà résolue par
	 * le routeur, et la faire passer par `resolve` demanderait de réécrire à la
	 * main le chemin qu'on a sous la main.
	 */
	function frappe() {
		clearTimeout(minuteur);
		minuteur = setTimeout(() => {
			const url = new URL(page.url);
			if (saisie.trim() === '') url.searchParams.delete('q');
			else url.searchParams.set('q', saisie);
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			goto(url, { keepFocus: true, noScroll: true, replaceState: true });
		}, 250);
	}

	// -----------------------------------------------------------------------
	// Glisser-déposer — un agrément, jamais le seul chemin
	// -----------------------------------------------------------------------

	let glissee: number | null = $state(null);
	let survolee: number | null = $state(null);

	let formeDeDeplacement: HTMLFormElement;
	let champEntree: HTMLInputElement;
	let champRang: HTMLInputElement;

	function deposer(cible: number) {
		const source = glissee;
		glissee = null;
		survolee = null;
		if (source === null || source === cible) return;

		champEntree.value = entrees[source].id;
		champRang.value = String(cible);
		formeDeDeplacement.requestSubmit();
	}

	const LIBELLES: Record<string, string> = {
		numero: 'numéro',
		recueil: 'recueil',
		film: 'film',
		serie: 'série',
		saison: 'saison',
		episode: 'épisode',
		roman: 'roman'
	};
</script>

<!-- Le formulaire que le dépôt soumet. Le champ de rang de chaque ligne fait
     exactement la même chose, en visible. -->
<form method="POST" action="?/deplacer" bind:this={formeDeDeplacement} class="hidden">
	<input type="hidden" name="entree" bind:this={champEntree} />
	<input type="hidden" name="rang" bind:this={champRang} />
</form>

<h2 class="mt-12 text-sm font-semibold tracking-tight">Verser des œuvres</h2>

<form method="GET" class="mt-2 flex gap-2">
	<input
		type="search"
		name="q"
		bind:value={saisie}
		oninput={frappe}
		placeholder="Chercher un titre…"
		class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
	/>
	<button class="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium">
		Chercher
	</button>
</form>

<!-- Une source qui ne répond pas ne fait pas échouer l’éditeur : elle le dit. -->
{#each degradations as degradation (degradation.source)}
	<p class="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
		{degradation.message}
	</p>
{/each}

{#if requete !== ''}
	{#if resultats.length === 0}
		<p class="mt-2 text-sm text-neutral-500">
			Rien sous « {requete} », ni ici ni chez les sources.
		</p>
	{:else}
		<ul class="mt-2 divide-y divide-neutral-200">
			{#each resultats as resultat (cle(resultat))}
				<li class="flex items-baseline justify-between gap-4 py-2">
					<div class="text-sm">
						<span class="font-medium">{resultat.titre}</span>
						<span class="text-neutral-500">
							· {LIBELLES[resultat.type] ?? resultat.type}
							{#if resultat.serie}· {resultat.serie}{/if}
							{#if resultat.numeroDansLaSerie !== null}· n° {resultat.numeroDansLaSerie}{/if}
							{#if !resultat.connueDuGroupe}· personne ne l’a consignée{/if}
						</span>
					</div>

					{#if resultat.dejaPresente}
						<span class="text-sm whitespace-nowrap text-neutral-400">Déjà dedans</span>
					{:else}
						<form method="POST" action="?/ajouter" class="flex items-center gap-2">
							<input type="hidden" name="oeuvre" value={resultat.id ?? ''} />
							<input type="hidden" name="source" value={resultat.reference?.source ?? ''} />
							<input type="hidden" name="idExterne" value={resultat.reference?.idExterne ?? ''} />
							<button class="text-sm font-medium underline underline-offset-4">Ajouter</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/if}

{#if series.length > 0}
	<form method="POST" action="?/ajouterSerie" class="mt-4 flex flex-wrap items-center gap-2">
		<label for="serie" class="text-sm text-neutral-500">Ou verser une série entière</label>
		<select
			id="serie"
			name="serie"
			class="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
		>
			{#each series as serie (serie.entityId)}
				<option value={serie.entityId}>{serie.nom} ({serie.nombreDOeuvres})</option>
			{/each}
		</select>
		<label class="flex items-center gap-1.5 text-sm text-neutral-500">
			<input type="checkbox" name="facultative" value="1" /> facultatives
		</label>
		<button class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium">
			Verser
		</button>
	</form>
{/if}

<h2 class="mt-10 text-sm font-semibold tracking-tight">
	Réordonner ({entrees.length})
</h2>
<p class="mt-1 text-sm text-neutral-500">
	Glisse une ligne pour la déplacer, ou sers-toi des flèches et du champ de rang — ils font la même
	chose et fonctionnent au clavier. Réordonner ne fait rien perdre à personne : la progression d’un
	suiveur est l’ensemble des œuvres qu’il a atteintes, jamais un rang.
</p>

{#if entrees.length === 0}
	<p class="mt-2 text-sm text-neutral-500">Rien encore. Cherche une œuvre au-dessus.</p>
{:else}
	<ul class="mt-2 divide-y divide-neutral-200">
		{#each entrees as entree, index (entree.id)}
			<li
				draggable="true"
				ondragstart={() => (glissee = index)}
				ondragend={() => ((glissee = null), (survolee = null))}
				ondragover={(evenement) => {
					evenement.preventDefault();
					survolee = index;
				}}
				ondrop={(evenement) => {
					evenement.preventDefault();
					deposer(index);
				}}
				class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 {survolee === index &&
				glissee !== null
					? 'bg-neutral-100'
					: ''} {glissee === index ? 'opacity-40' : ''}"
			>
				<span class="w-8 cursor-grab text-sm text-neutral-400 select-none" aria-hidden="true">
					⠿ {entree.rang + 1}
				</span>

				<span class="min-w-0 flex-1 text-sm">
					{#if entree.oeuvre}
						<span class="font-medium">{entree.oeuvre.titre}</span>
					{:else}
						<span class="text-neutral-400 italic">Œuvre disparue du catalogue</span>
					{/if}
					{#if entree.facultative}
						<span class="text-neutral-500">· facultative</span>
					{/if}
					{#if entree.atteinte}
						<span class="text-neutral-500">· atteinte</span>
					{/if}
				</span>

				<!--
					Une seule forme par ligne, plusieurs boutons : les formulaires ne
					s'imbriquent pas, et trois cents lignes n'ont pas besoin de quatre
					formulaires chacune.

					**L'ordre du balisage n'est pas l'ordre à l'écran**, et c'est
					délibéré. Entrée dans un champ soumet le formulaire par son *premier*
					bouton de soumission — donc si « ↑ » venait en premier dans le
					balisage, taper un rang puis Entrée ferait monter d'un cran au lieu de
					placer, et sur la première ligne, où « ↑ » est désactivé, ne ferait
					rien du tout. « Placer » vient donc en tête du balisage, et les
					classes `order-*` le remettent à sa place visuelle.
				-->
				<form method="POST" class="flex items-center gap-2 text-sm">
					<input type="hidden" name="entree" value={entree.id} />

					<label class="order-3 flex items-center gap-1 text-neutral-500">
						<span class="sr-only">Rang</span>
						<input
							type="number"
							name="rang"
							min="1"
							max={entrees.length}
							value={entree.rang + 1}
							class="w-16 rounded-md border border-neutral-300 px-2 py-1"
						/>
					</label>
					<button formaction="?/deplacer" class="order-4 underline underline-offset-4">
						Placer
					</button>

					<button
						formaction="?/monter"
						disabled={index === 0}
						aria-label="Monter d’un rang"
						class="order-1 rounded border border-neutral-300 px-1.5 disabled:opacity-30"
					>
						↑
					</button>
					<button
						formaction="?/descendre"
						disabled={index === entrees.length - 1}
						aria-label="Descendre d’un rang"
						class="order-2 rounded border border-neutral-300 px-1.5 disabled:opacity-30"
					>
						↓
					</button>

					<input type="hidden" name="facultative" value={entree.facultative ? '' : '1'} />
					<button formaction="?/basculer" class="order-5 underline underline-offset-4">
						{entree.facultative ? 'Rendre essentielle' : 'Rendre facultative'}
					</button>

					<button formaction="?/retirer" class="order-6 text-red-600 underline underline-offset-4">
						Retirer
					</button>
				</form>
			</li>
		{/each}
	</ul>
{/if}
