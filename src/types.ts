export interface HarvestUserRef {
	id: number;
	name: string;
}

export interface HarvestClientRef {
	id: number;
	name: string;
}

export interface HarvestProjectRef {
	id: number;
	name: string;
	code: string | null;
}

export interface HarvestTaskRef {
	id: number;
	name: string;
}

export interface HarvestTimeEntry {
	id: number;
	spent_date: string; // YYYY-MM-DD
	hours: number;
	notes: string | null;
	billable: boolean;
	created_at: string;
	updated_at: string;
	user: HarvestUserRef;
	client: HarvestClientRef;
	project: HarvestProjectRef;
	task: HarvestTaskRef;
}

export interface HarvestUser {
	id: number;
	first_name: string;
	last_name: string;
	email: string;
	is_active: boolean;
}

export interface HarvestUsersPage {
	users: HarvestUser[];
	per_page: number;
	total_pages: number;
	total_entries: number;
	next_page: number | null;
	previous_page: number | null;
	page: number;
}

export interface HarvestTimeEntriesPage {
	time_entries: HarvestTimeEntry[];
	per_page: number;
	total_pages: number;
	total_entries: number;
	next_page: number | null;
	previous_page: number | null;
	page: number;
}
