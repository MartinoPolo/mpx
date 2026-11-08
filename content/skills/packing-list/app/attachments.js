// A checkbox's indeterminate state is a property only, so markup cannot set it.
export const indeterminate = (value) => (input) => {
	input.indeterminate = value;
};
