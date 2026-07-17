connection: "food_service_demo"

include: "/*.view.lkml"
include: "/*.dashboard.lookml"

explore: daily_grill_report {
  label: "NorthstarTopic"
  join: northstar_locations {
    type: left_outer
    relationship: many_to_one
    sql_on: ${daily_grill_report.store_number} = ${northstar_locations.store_number} ;;
  }
  join: bag_tickets {
    type: left_outer
    relationship: one_to_one
    sql_on: ${daily_grill_report.order_id} = ${bag_tickets.order_id} ;;
  }
  join: grill_slips {
    type: left_outer
    relationship: one_to_many
    sql_on: ${daily_grill_report.order_id} = ${grill_slips.order_id} ;;
  }
  join: menu_board {
    type: left_outer
    relationship: many_to_one
    sql_on: ${grill_slips.menu_item_id} = ${menu_board.menu_item_id} ;;
  }
  join: menu_item_pnl {
    type: left_outer
    relationship: many_to_one
    sql_on: ${grill_slips.menu_item_id} = ${menu_item_pnl.menu_item_id} ;;
  }
}
