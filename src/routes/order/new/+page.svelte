<script lang="ts">
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head><title>Nouvel ordre — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
	<h1 class="font-display text-2xl leading-none tracking-tight">Écrire un ordre</h1>
	<p class="mt-3 text-sm leading-relaxed text-encre-basse">
		Il n’existe pas de chronologie officielle de soixante ans de continuité, et le produit ne
		prétendra pas en tenir une. Un ordre, c’est ton chemin — signé, suivable, et que n’importe qui
		peut forker pour le refaire à sa main.
	</p>

	<form method="POST" class="mt-8 flex flex-col gap-5">
		<label class="flex flex-col gap-1.5">
			<span class="enseigne">Titre</span>
			<input
				name="titre"
				value={form?.titre ?? ''}
				placeholder="Entrer chez les X-Men sans se noyer"
				class="champ w-full"
			/>
		</label>

		<label class="flex flex-col gap-1.5">
			<span class="enseigne">Description</span>
			<textarea
				name="description"
				rows="5"
				placeholder="À qui ça s’adresse, ce que ça saute, et pourquoi."
				class="champ w-full leading-relaxed">{form?.description ?? ''}</textarea
			>
		</label>

		<p class="text-xs leading-relaxed text-encre-tenue">
			Un titre est du texte libre et peut gâcher quelque chose à qui le lit dans une liste. Le
			produit n’a aucun moyen de l’en empêcher.
		</p>

		{#if form?.message}
			<p class="border-l-2 border-braise pl-4 text-sm text-encre-basse">{form.message}</p>
		{/if}

		<div>
			<button class="action">Créer, puis y verser des œuvres</button>
		</div>
	</form>
</main>
