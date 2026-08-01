<script lang="ts">
	import Etoiles from './Etoiles.svelte';

	/**
	 * Un avis, masqué ou non — et c'est la **même carte** dans les deux cas.
	 *
	 * R31 veut qu'un contenu masqué reste visible en tant qu'objet : on sait
	 * qu'il existe et qui l'a écrit. Le risque concret, que R31 existe justement
	 * pour éviter, est de rendre « masqué » indiscernable de « inexistant » — un
	 * avis qu'on ne montre pas du tout est un avis que personne ne saura jamais
	 * chercher. La carte porte donc toujours l'auteur, la note et la date, qui ne
	 * sont jamais masqués (R28) ; seul le texte est remplacé par une phrase de
	 * substitution et par le geste qui l'ouvre.
	 *
	 * **Le texte masqué n'est pas ici.** Il n'a jamais quitté le serveur : la
	 * propriété `texte` vaut `null`, et aucun attribut caché ne le porte. Le
	 * bouton n'est donc pas un basculement d'affichage mais un aller-retour
	 * serveur, qui enregistre la révélation puis renvoie la page avec le texte.
	 *
	 * L'avertissement est une étape de `<details>` plutôt qu'un état JavaScript :
	 * il fonctionne sans script, et le geste reste en deux temps — on ne se gâche
	 * pas une œuvre par un clic mal placé.
	 *
	 * **Un avis masqué doit se lire comme délibéré, pas comme cassé.** D'où le
	 * traitement : le bloc de substitution est une surface pleine, en élévation,
	 * marquée d'un liseré d'or sourd et d'une phrase composée dans la display du
	 * produit. Il occupe la place qu'occuperait le texte, il ne s'en excuse pas,
	 * et il ne ressemble à aucun message d'erreur — c'est une mécanique dont le
	 * produit est fier.
	 */
	interface Props {
		/** L'œuvre concernée, que le formulaire de révélation reporte. */
		oeuvreId: string;
		auteur: string;
		/** R28 — jamais masquée. */
		note?: number | null;
		ecritLe?: number | null;
		masque: boolean;
		/** `null` quand la règle refuse. Le texte n'est alors pas dans la page. */
		texte: string | null;
		/** L'action de révélation de la surface courante. */
		action?: string;
		/**
		 * Le texte vient-il d'être ouvert par une révélation ? Mouvement 3 : il se
		 * découvre alors d'un coup, du haut vers le bas, pour que le geste ait le
		 * poids de ce qu'il coûte — on ne revient pas en arrière.
		 */
		revele?: boolean;
	}

	let {
		oeuvreId,
		auteur,
		note = null,
		ecritLe = null,
		masque,
		texte,
		action = '?/reveler',
		revele = false
	}: Props = $props();

	const dateCourte = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<article class="py-4">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h3 class="text-sm tracking-wide text-encre">{auteur}</h3>
		<p class="flex items-baseline gap-2 text-xs text-encre-tenue">
			{#if note !== null}<Etoiles valeur={note} />{/if}
			{#if ecritLe !== null}<span>{dateCourte(ecritLe)}</span>{/if}
		</p>
	</div>

	{#if !masque && texte !== null}
		<p
			class="mt-2 text-sm leading-relaxed whitespace-pre-line text-encre-basse
				{revele ? 'animate-revelation' : ''}"
		>
			{texte}
		</p>
	{:else}
		<div class="mt-2 border-l-2 border-or-sourd bg-cimaise px-4 py-3">
			<p class="font-display text-base leading-snug text-encre-basse">
				Il y a un texte ici. Il t’attend de l’autre côté de cette œuvre.
			</p>
			<p class="mt-1 text-xs text-encre-tenue">
				Un avis s’ouvre quand tu atteins l’œuvre — terminée, ou abandonnée.
			</p>

			<details class="avertissement mt-3">
				<summary class="action-sourde cursor-pointer list-none">Le lire quand même</summary>

				<div class="mt-3 border-t border-trait pt-3">
					<p class="text-sm leading-relaxed text-encre-basse">
						Ce texte a été écrit par quelqu’un qui est allé plus loin que toi. Il peut te gâcher la
						suite, et une fois lu, on ne revient pas en arrière.
					</p>
					<form method="POST" {action} class="mt-3">
						<input type="hidden" name="oeuvre" value={oeuvreId} />
						<button class="risque text-sm">Révéler quand même</button>
					</form>
				</div>
			</details>
		</div>
	{/if}
</article>

<style>
	/*
	 * L'avertissement s'ouvre d'un coup net. Le `<details>` fait tout le
	 * travail ; l'animation ne porte que le contenu déjà ouvert, ce qui la rend
	 * possible sans script et sans hauteur mesurée.
	 */
	.avertissement[open] > div {
		animation: var(--animate-revelation);
	}

	.avertissement > summary::-webkit-details-marker {
		display: none;
	}
</style>
