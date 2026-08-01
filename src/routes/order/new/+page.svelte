<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head><title>Nouvel ordre — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/orders')} class="text-sm text-neutral-500 underline underline-offset-4">
		Les ordres
	</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">Écrire un ordre</h1>
	<p class="mt-2 text-sm text-neutral-500">
		Il n’existe pas de chronologie officielle de soixante ans de continuité, et le produit ne
		prétendra pas en tenir une. Un ordre, c’est ton chemin — signé, suivable, et que n’importe qui
		peut forker pour le refaire à sa main.
	</p>

	<form method="POST" class="mt-8 flex flex-col gap-3">
		<label class="text-sm">
			<span class="text-neutral-500">Titre</span>
			<input
				name="titre"
				value={form?.titre ?? ''}
				placeholder="Entrer chez les X-Men sans se noyer"
				class="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
			/>
		</label>

		<label class="text-sm">
			<span class="text-neutral-500">Description</span>
			<textarea
				name="description"
				rows="4"
				placeholder="À qui ça s’adresse, ce que ça saute, et pourquoi."
				class="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
				>{form?.description ?? ''}</textarea
			>
		</label>

		<p class="text-xs text-neutral-400">
			Un titre est du texte libre et peut gâcher quelque chose à qui le lit dans une liste. Le
			produit n’a aucun moyen de l’en empêcher.
		</p>

		{#if form?.message}
			<p class="text-sm text-red-600">{form.message}</p>
		{/if}

		<div>
			<button
				class="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700"
			>
				Créer, puis y verser des œuvres
			</button>
		</div>
	</form>
</main>
