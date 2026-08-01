<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const explications: Record<string, string> = {
		introuvable: 'Ce lien n’existe pas. Il a peut-être été mal recopié.',
		consommée: 'Ce lien a déjà servi. Chaque invitation ne vaut qu’une fois.',
		révoquée: 'Ce lien a été révoqué par la personne qui l’a émis.',
		expirée: 'Ce lien a expiré. Demande-en un nouveau.'
	};
</script>

<svelte:head><title>Rejoindre — readerbox</title></svelte:head>

<main class="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
	{#if data.etat === 'valide'}
		<h1 class="text-2xl font-semibold tracking-tight">On t’attendait</h1>
		<p class="mt-2 text-sm text-neutral-500">
			Choisis le nom sous lequel le groupe te verra. Tu pourras le changer plus tard.
		</p>

		<form method="POST" class="mt-8 flex flex-col gap-3">
			<label class="flex flex-col gap-1.5">
				<span class="text-sm font-medium">Ton nom</span>
				<input
					name="nom"
					required
					minlength="2"
					autocomplete="nickname"
					class="rounded-md border border-neutral-300 px-3 py-2 outline-none focus:border-neutral-900"
				/>
			</label>

			{#if form?.message}
				<p class="text-sm text-red-600">{form.message}</p>
			{/if}

			<button
				type="submit"
				class="mt-2 rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700"
			>
				Rejoindre le groupe
			</button>
		</form>
	{:else}
		<h1 class="text-2xl font-semibold tracking-tight">Ce lien ne marche plus</h1>
		<p class="mt-2 text-sm text-neutral-500">{explications[data.etat] ?? 'Lien invalide.'}</p>
		<a href={resolve('/')} class="mt-6 text-sm underline underline-offset-4">Retour à l’accueil</a>
	{/if}
</main>
