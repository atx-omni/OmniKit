connection: "example_warehouse"

include: "/looker_professional.view.lkml"

explore: example_orders {
  label: "Example orders"
  always_filter: { filters: [example_orders.status: "-cancelled"] }
  access_filter: { field: example_accounts.segment user_attribute: account_segment }

  join: example_accounts {
    type: left_outer
    relationship: many_to_one
    sql_on: ${example_orders.account_id} = ${example_accounts.id} ;;
  }
}
