<script lang="ts">
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
	}

	let {
		oeuvreId,
		auteur,
		note = null,
		ecritLe = null,
		masque,
		texte,
		action = '?/reveler'
	}: Props = $props();

	/** La note en étoiles, demi-étoiles comprises (R4). */
	function etoiles(valeur: number): string {
		return '★'.repeat(Math.floor(valeur)) + (valeur % 1 === 0.5 ? '½' : '');
	}

	const dateCourte = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<article class="py-3">
	<div class="flex items-baseline justify-between gap-4">
		<span class="text-sm font-medium">{auteur}</span>
		<span class="text-sm text-neutral-500">
			{#if note !== null}{etoiles(note)}{/if}
			{#if ecritLe !== null}
				<span class="text-neutral-400">· {dateCourte(ecritLe)}</span>
			{/if}
		</span>
	</div>

	{#if !masque && texte !== null}
		<p class="mt-1 text-sm whitespace-pre-line text-neutral-700">{texte}</p>
	{:else}
		<p class="mt-1 text-sm text-neutral-400 italic">Avis masqué — termine l’œuvre pour le lire.</p>

		<details class="mt-1">
			<summary
				class="inline-block cursor-pointer list-none text-sm text-neutral-500 underline underline-offset-4"
			>
				Le lire quand même
			</summary>
			<div class="mt-2 rounded-md border border-neutral-300 bg-neutral-50 p-3">
				<p class="text-sm text-neutral-700">
					Ce texte a été écrit par quelqu’un qui est allé plus loin que toi. Il peut te gâcher la
					suite, et une fois lu, on ne revient pas en arrière.
				</p>
				<form method="POST" {action} class="mt-2">
					<input type="hidden" name="oeuvre" value={oeuvreId} />
					<button class="text-sm font-medium text-red-600 underline underline-offset-4">
						Révéler quand même
					</button>
				</form>
			</div>
		</details>
	{/if}
</article>
