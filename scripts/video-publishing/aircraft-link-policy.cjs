function assertAircraftLinkPolicy(id,pkg,policy){
 const p=policy?.content_aircraft_product_link_policy;
 const aircraft=pkg.product_family==='aircraft'||/^(AV8B2633|F15C241|SU24|KJ600|V22)(-|$)/.test(id)||p?.known_aircraft_product_ids?.includes(pkg.product_id);
 if(aircraft&&p?.new_individual_links_currently_paused===true&&pkg.product_id!==p.main_product_id)throw Error('AIRCRAFT_MAIN_LINK_REQUIRED: '+id+'; current human paused individual links; exact corresponding main-parent variant proof still required');
 return {aircraft,main_link_policy_applied:!!p&&aircraft};
}
module.exports={assertAircraftLinkPolicy};
